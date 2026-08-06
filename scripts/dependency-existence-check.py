#!/usr/bin/env python3
"""Proactive slopsquatting check: every declared dependency must exist in its
registry and (where the registry exposes dates) be at least 14 days old.

Content-based discovery: walks the repository tree (respecting .gitignore),
detects manifest files by filename and content at any depth, and extracts the
declared dependencies. Lockfiles are preferred over plain manifests where both
exist, because they carry the authoritative resolved dependency set.

Stdlib only (Python 3.11+): json, xml.etree, tomllib, re, urllib, ast.

Exit codes: 0 all pass, 1 findings, 2 usage error.

Design: one Adapter per language/registry pair, registered in the ADAPTERS
table; one RegistryClient per registry, registered in REGISTRIES. The core
pipeline (walk -> detect -> extract -> ignore -> dedupe -> query -> age-check
-> report) never imports manifest or registry detail, so adding a language is
one class plus one table row.
"""

from __future__ import annotations

import argparse
import ast
import datetime
import fnmatch
import hashlib
import json
import math
import os
import re
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime as _dt, timezone
from pathlib import Path

# Mirrors .pi/extensions/supervisor/checks/package-safety.ts SAFETY_THRESHOLD_DAYS.
SAFETY_THRESHOLD_DAYS = 14

USER_AGENT = "cheasee-pi-dependency-existence-check/1.0 (+https://github.com/SchneiderDaniel/cheasee-pi)"

# Always skipped during discovery regardless of .gitignore rules.
ALWAYS_SKIP_DIRS = {".git", "node_modules"}

# ─── data models ────────────────────────────────────────────────────


@dataclass
class Dependency:
    language: str
    name: str
    version: str | None = None
    source_file: str = ""  # absolute at extraction time; relativized by core
    line: int = 0  # 0 = unknown (structured formats); resolved by core
    transitive: bool = False
    priority: int = 10
    registry_name: str | None = None  # overrides the adapter default (C/C++)


@dataclass
class PackageRecord:
    exists: bool
    earliest_release_iso: str | None = None


class RegistryError(Exception):
    """Registry unreachable, malformed response, or unusable data."""


# ─── helpers ────────────────────────────────────────────────────────


def days_since(iso: str | None) -> int | None:
    """Whole days between now and iso (floor semantics, UTC).

    None for missing/unparseable input — fail-closed callers treat that as a
    violation. Mirrors daysSince() in package-safety.ts.
    """
    if not iso:
        return None
    try:
        dt = _dt.fromisoformat(iso.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return math.floor((_dt.now(timezone.utc) - dt).total_seconds() / 86400)


def _local(tag: str) -> str:
    """Strip an XML namespace prefix from a tag name."""
    return tag.rsplit("}", 1)[-1]


# ─── transport: cache, rate limit, fetcher ─────────────────────────


class CacheStats:
    def __init__(self) -> None:
        self.hits = 0
        self.misses = 0
        self.requests = 0


class DiskCache:
    """Per-URL (status, body, etag) entries persisted under a cache dir."""

    def __init__(self, cache_dir: Path) -> None:
        self.dir = cache_dir
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, url: str) -> Path:
        h = hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
        return self.dir / f"{h}.json"

    def get(self, url: str) -> tuple[int, str, str | None] | None:
        try:
            data = json.loads(self._path(url).read_text(encoding="utf-8"))
            return int(data["status"]), str(data["body"]), data["etag"]
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            return None

    def store(self, url: str, entry: tuple[int, str, str | None]) -> None:
        try:
            status, body, etag = entry
            self._path(url).write_text(
                json.dumps({"status": status, "body": body, "etag": etag}),
                encoding="utf-8",
            )
        except OSError:
            pass  # cache is best-effort; never fail the check for it


class NoCache:
    def get(self, url: str):
        return None

    def store(self, url: str, entry) -> None:
        pass


class RateLimiter:
    """Token-bucket-ish spacing: at most one request per `interval` seconds."""

    def __init__(self, interval: float) -> None:
        self.interval = interval
        self._next = 0.0

    def wait(self) -> None:
        delay = self._next - time.monotonic()
        if delay > 0:
            time.sleep(delay)

    def mark(self) -> None:
        self._next = time.monotonic() + self.interval


class RealFetcher:
    """urllib-backed fetcher with ETag + disk caching.

    Fetcher contract (also implemented by the offline fake in the test suite):
        cache_entry(url) -> (status, body, etag) | None
        get(url, etag=None) -> (status, body, new_etag)
            - a cache entry with no etag argument is served without network
            - a conditional request answered 304 reuses the cached body
        stats -> object with hits/misses/requests counters
    """

    def __init__(self, cache_dir: str, opener=None) -> None:
        self.cache: DiskCache | NoCache = (
            DiskCache(Path(cache_dir)) if cache_dir else NoCache()
        )
        self.stats = CacheStats()
        self.opener = opener or self._urllib_open

    def cache_entry(self, url: str):
        return self.cache.get(url)

    def get(self, url: str, etag: str | None = None):
        entry = self.cache.get(url)
        if entry is not None and etag is None:
            self.stats.hits += 1
            return entry
        status, headers, body = self.opener(url, {"User-Agent": USER_AGENT}, etag)
        if status == 304 and entry is not None:
            self.stats.hits += 1
            return entry
        self.stats.misses += 1
        self.stats.requests += 1
        entry = (status, body, headers.get("ETag"))
        if status < 500:
            # never cache transient 5xx errors: retries must re-hit the network
            self.cache.store(url, entry)
        return entry

    def _urllib_open(self, url: str, headers: dict, etag: str | None):
        req = urllib.request.Request(url, headers=headers)
        if etag:
            req.add_header("If-None-Match", etag)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read().decode("utf-8", "replace")


# ─── gitignore matching ─────────────────────────────────────────────


class GitignoreMatcher:
    """Best-effort gitignore matcher (no pathlib dependency on pathspec).

    Supports: `*`, `?`, `[...]`, `**`, `/`-anchored patterns, `!` negation,
    `#` comments, dir-only trailing `/`. Loaded per-directory during the walk.
    """

    def __init__(self, root: Path) -> None:
        self.root = root
        self.rules: list[tuple[Path, re.Pattern, bool, bool, bool]] = []

    def load_dir(self, dir_abs: Path) -> None:
        gitignore = dir_abs / ".gitignore"
        if not gitignore.is_file():
            return
        base = dir_abs.relative_to(self.root)
        try:
            lines = gitignore.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return
        for line in lines:
            line = line.rstrip()
            if not line or line.startswith("#"):
                continue
            negated = line.startswith("!")
            if negated:
                line = line[1:]
            dir_only = line.endswith("/")
            if dir_only:
                line = line[:-1]
            if not line:
                continue
            leading_slash = line.startswith("/")
            if leading_slash:
                line = line[1:]
            rx = self._translate(line)
            anchored = leading_slash or "/" in line
            self.rules.append((base, rx, negated, dir_only, anchored))

    @staticmethod
    def _translate(pat: str) -> re.Pattern:
        out = []
        i = 0
        n = len(pat)
        while i < n:
            c = pat[i]
            if c == "*":
                if i + 1 < n and pat[i + 1] == "*":
                    if i + 2 < n and pat[i + 2] == "/":
                        out.append("(?:[^/]+/)*")
                        i += 3
                    else:
                        out.append(".*")
                        i += 2
                else:
                    out.append("[^/]*")
                    i += 1
            elif c == "?":
                out.append("[^/]")
                i += 1
            elif c == "[":
                j = i + 1
                if j < n and pat[j] in "!^":
                    j += 1
                if j < n and pat[j] == "]":
                    j += 1
                while j < n and pat[j] != "]":
                    j += 1
                if j < n:
                    cls = pat[i + 1:j]
                    if cls.startswith("!"):
                        cls = "^" + cls[1:]
                    out.append("[" + cls + "]")
                    i = j + 1
                else:
                    out.append(re.escape(c))
                    i += 1
            else:
                out.append(re.escape(c))
                i += 1
        return re.compile("^" + "".join(out) + "$")

    def matches(self, rel: Path, is_dir: bool = False) -> bool:
        """True if the relative path is excluded (after applying negations)."""
        matched = False
        for base, rx, negated, dir_only, anchored in self.rules:
            if dir_only and not is_dir:
                continue
            if anchored:
                try:
                    test = rel.relative_to(base)
                except ValueError:
                    continue
                test_str = str(test)
            else:
                test_str = rel.name
            if rx.match(test_str):
                matched = not negated
        return matched


# ─── ignore mechanism ───────────────────────────────────────────────


class IgnoreFilter:
    """Reads `.slopsquat-ignore` at --root (never nested).

    Lines: `# comment`, exact `name`, scoped `lang:name`, globs (`internal-*`).
    """

    def __init__(self, root: Path) -> None:
        self.rules: list[tuple[str | None, str]] = []
        p = root / ".slopsquat-ignore"
        if not p.is_file():
            return
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                lang, pat = line.split(":", 1)
                self.rules.append((lang.strip(), pat.strip()))
            else:
                self.rules.append((None, line))

    def ignored(self, language: str, name: str) -> bool:
        for lang, pat in self.rules:
            if lang is not None and lang != language:
                continue
            if fnmatch.fnmatchcase(name, pat):
                return True
        return False


# ─── registry clients ───────────────────────────────────────────────


class Registry:
    """One per registry. `check(name)` -> PackageRecord; raises RegistryError."""

    name = "base"
    interval = 3.0
    age_supported = True

    def __init__(self, fetcher) -> None:
        self.fetcher = fetcher
        self.limiter = RateLimiter(self.interval)

    def _url(self, name: str) -> str:
        raise NotImplementedError

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        raise NotImplementedError

    def _request(self, url: str, etag: str | None = None):
        """Rate-limited fetch with two retries; fail-closed on repeated 5xx/errors."""
        last: Exception | str = "unknown error"
        for attempt in range(3):
            self.limiter.wait()
            try:
                status, body, new_etag = self.fetcher.get(url, etag)
                self.limiter.mark()
            except Exception as e:  # network error
                self.limiter.mark()
                last = e
                continue
            if status < 500:
                return status, body, new_etag
            last = f"HTTP {status}"
        raise RegistryError(
            f"registry {self.name} unreachable for {url} after 3 attempts ({last})"
        )

    def check(self, name: str) -> PackageRecord:
        url = self._url(name)
        cached = self.fetcher.cache_entry(url)
        etag = cached[2] if cached else None
        status, body, _ = self._request(url, etag)
        return self._parse(name, status, body)

    @staticmethod
    def _json(body: str, what: str) -> dict:
        try:
            data = json.loads(body)
        except json.JSONDecodeError as e:
            raise RegistryError(f"malformed JSON response for {what}: {e}") from None
        if not isinstance(data, dict):
            raise RegistryError(f"unexpected response shape for {what}")
        return data


class PypiRegistry(Registry):
    name = "pypi"
    interval = 3.0

    def _url(self, name: str) -> str:
        # PyPI canonical normalization: lowercase, `-_.` runs -> `-`.
        n = re.sub(r"[-_.]+", "-", name).lower()
        return f"https://pypi.org/pypi/{n}/json"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        times = []
        for files in (data.get("releases") or {}).values():
            for f in files or []:
                t = f.get("upload_time")
                if t:
                    times.append(t)
        if not times:
            # Missing dates are fail-closed by the core age guard (too-young),
            # not a transport failure.
            return PackageRecord(True, None)
        return PackageRecord(True, min(times))


class NpmRegistry(Registry):
    name = "npm"
    interval = 1.0

    def _url(self, name: str) -> str:
        n = urllib.parse.quote(name, safe="@")  # scoped names: @scope%2fname
        return f"https://registry.npmjs.org/{n}"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        t = (data.get("time") or {}).get("created")
        if not t:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, t)


class GoRegistry(Registry):
    name = "go"
    interval = 2.0

    def _url(self, name: str) -> str:
        # Go module proxy encoding: uppercase -> `!` + lowercase.
        n = re.sub(r"[A-Z]", lambda m: "!" + m.group(0).lower(), name)
        return f"https://proxy.golang.org/{n}/@latest"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        t = data.get("Time")
        if not t:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, t)


class CargoRegistry(Registry):
    name = "crates"
    interval = 1.0

    def _url(self, name: str) -> str:
        return f"https://crates.io/api/v1/crates/{urllib.parse.quote(name, safe='')}"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        t = (data.get("crate") or {}).get("created_at")
        if not t:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, t)


class MavenRegistry(Registry):
    name = "maven"
    interval = 3.0

    def check(self, name: str) -> PackageRecord:
        if ":" not in name:
            raise RegistryError(f"maven: dependency name {name!r} is not group:artifact")
        group, artifact = name.split(":", 1)
        base = f"https://repo1.maven.org/maven2/{group.replace('.', '/')}/{artifact}"
        status, body, _ = self._request(base + "/maven-metadata.xml")
        if status == 404:
            return PackageRecord(False)
        try:
            root = ET.fromstring(body)
        except ET.ParseError as e:
            raise RegistryError(f"maven: unparseable metadata for {name}: {e}") from None
        versions = []
        for el in root.iter():
            if _local(el.tag) == "versions":
                versions = [v.text for v in el if v.text]
                break
        if not versions:
            return PackageRecord(False)
        earliest = min(versions)
        status2, body2, _ = self._request(f"{base}/{earliest}/maven-metadata.xml")
        if status2 == 404:
            return PackageRecord(True, None)  # no date -> core fails closed
        try:
            root2 = ET.fromstring(body2)
        except ET.ParseError as e:
            raise RegistryError(f"maven: unparseable version metadata for {name}: {e}") from None
        ts = None
        for el in root2.iter():
            if _local(el.tag) == "lastUpdated":
                ts = (el.text or "").strip()
                break
        if not ts:
            return PackageRecord(True, None)  # no date -> core fails closed
        try:
            dt = datetime.datetime.strptime(ts, "%Y%m%d%H%M%S")
        except ValueError:
            return PackageRecord(True, None)  # unparseable date -> fails closed
        return PackageRecord(True, dt.replace(tzinfo=timezone.utc).isoformat())


class NugetRegistry(Registry):
    name = "nuget"
    interval = 2.0

    def _url(self, name: str) -> str:
        # Registration ids are case-insensitive; lowercase is canonical.
        return f"https://api.nuget.org/v3/registration5-semver1/{name.lower()}/index.json"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        published = []
        for item in data.get("items") or []:
            inner = item.get("items")
            if isinstance(inner, list):  # paged leaf
                for sub in inner:
                    t = (sub.get("catalogEntry") or {}).get("published")
                    if t:
                        published.append(t)
            else:
                t = (item.get("catalogEntry") or {}).get("published")
                if t:
                    published.append(t)
        if not published:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, min(published))


class VcpkgRegistry(Registry):
    name = "vcpkg"
    interval = 2.0
    age_supported = False

    def _url(self, name: str) -> str:
        return f"https://raw.githubusercontent.com/microsoft/vcpkg/master/ports/{urllib.parse.quote(name, safe='')}/vcpkg.json"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 200:
            return PackageRecord(True)
        if status == 404:
            return PackageRecord(False)
        raise RegistryError(f"vcpkg: unexpected status {status} for {name}")


class ConanRegistry(Registry):
    name = "conan"
    interval = 2.0
    age_supported = False

    def _url(self, name: str) -> str:
        return f"https://conan.io/center/recipes/{urllib.parse.quote(name, safe='')}"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 200:
            return PackageRecord(True)
        if status == 404:
            return PackageRecord(False)
        raise RegistryError(f"conan: unexpected status {status} for {name}")


class RubygemsRegistry(Registry):
    name = "rubygems"
    interval = 2.0

    def _url(self, name: str) -> str:
        return f"https://rubygems.org/api/v1/gems/{urllib.parse.quote(name, safe='')}.json"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        t = data.get("created_at")
        if not t:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, t)


class PackagistRegistry(Registry):
    name = "packagist"
    interval = 2.0

    def _url(self, name: str) -> str:
        if "/" not in name:
            raise RegistryError(f"packagist: dependency name {name!r} has no vendor/name form")
        vendor, package = name.split("/", 1)
        return f"https://repo.packagist.org/p2/{vendor}/{package}.json"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        times = []
        for versions in (data.get("packages") or {}).values():
            for ver in versions or []:
                t = ver.get("time")
                if t:
                    times.append(t)
        if not times:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, min(times))


class SwiftRegistry(Registry):
    name = "swift"
    interval = 2.0
    age_supported = False

    def _url(self, name: str) -> str:
        return f"https://swiftpackageindex.com/{name}"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 200:
            return PackageRecord(True)
        if status == 404:
            return PackageRecord(False)
        raise RegistryError(f"swift: unexpected status {status} for {name}")


class PubRegistry(Registry):
    name = "pub"
    interval = 2.0

    def _url(self, name: str) -> str:
        return f"https://pub.dev/api/packages/{urllib.parse.quote(name, safe='')}"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        data = self._json(body, name)
        times = [
            v["published"]
            for v in (data.get("versions") or [])
            if isinstance(v, dict) and isinstance(v.get("published"), str)
        ]
        if not times:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, min(times))


REGISTRIES: dict[str, type[Registry]] = {
    "pypi": PypiRegistry,
    "npm": NpmRegistry,
    "go": GoRegistry,
    "crates": CargoRegistry,
    "maven": MavenRegistry,
    "nuget": NugetRegistry,
    "vcpkg": VcpkgRegistry,
    "conan": ConanRegistry,
    "rubygems": RubygemsRegistry,
    "packagist": PackagistRegistry,
    "swift": SwiftRegistry,
    "pub": PubRegistry,
}


# ─── language adapters ──────────────────────────────────────────────


def _pep508_name(spec: str) -> str | None:
    m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)", spec.strip())
    return m.group(1) if m else None


class Adapter:
    """Manifest grammar + registry binding. One class per language."""

    language = "base"
    patterns: tuple[str, ...] = ()
    priority = 10  # lockfiles / central manifests rank higher
    age_supported = True
    registry_name = "pypi"
    inline_marker: str | None = None  # trailing comment that ignores a dep line

    def detect(self, rel: Path, text: str) -> bool:
        return any(fnmatch.fnmatchcase(rel.name, p) for p in self.patterns)

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        return []

    def _dep(self, name: str, version: str | None, line: int = 0,
             transitive: bool = False, path: Path | None = None,
             priority: int | None = None, registry_name: str | None = None) -> Dependency:
        return Dependency(
            self.language, name, version, str(path) if path else "", line,
            transitive,
            self.priority if priority is None else priority,
            registry_name,
        )


class PythonAdapter(Adapter):
    language = "python"
    patterns = ("requirements*.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg")
    priority = 10
    registry_name = "pypi"
    inline_marker = "# slopsquat-ignore"

    def detect(self, rel: Path, text: str) -> bool:
        name = rel.name
        if fnmatch.fnmatchcase(name, "requirements*.txt") or name in ("pyproject.toml", "setup.cfg"):
            return True
        if name == "Pipfile":
            try:
                tomllib.loads(text)
                return True
            except tomllib.TOMLDecodeError:
                return False
        if name == "setup.py":
            return "install_requires" in text or "setup(" in text or "setuptools" in text
        return False

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if fnmatch.fnmatchcase(name, "requirements*.txt"):
            return self._requirements(text, path)
        if name in ("pyproject.toml", "Pipfile"):
            try:
                data = tomllib.loads(text)
            except tomllib.TOMLDecodeError:
                return []
            if name == "Pipfile":
                return self._pipfile(data, path)
            return self._toml(data, path)
        if name == "setup.cfg":
            return self._setup_cfg(text, path)
        if name == "setup.py":
            return self._setup_py(text, path)
        return []

    def _requirements(self, text: str, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        base = (path.parent if path else Path("."))
        seen: set[Path] = set()

        def parse(content: str, bdir: Path, src: str) -> None:
            for i, raw in enumerate(content.splitlines(), 1):
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                m = re.match(r"-(?:r|requirement)\s+(\S+)", line)
                if m:
                    inc = (bdir / m.group(1)).resolve()
                    if inc in seen:
                        continue
                    seen.add(inc)
                    try:
                        parse(inc.read_text(encoding="utf-8", errors="replace"),
                              inc.parent, str(inc))
                    except OSError:
                        continue
                    continue
                if line.startswith("-"):
                    continue  # other options (-e, -c, -i, ...)
                spec = re.match(
                    r"^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~;].*)?$", line
                )
                if not spec:
                    continue
                dep_name = spec.group(1)
                if "/" in dep_name or "\\" in dep_name or dep_name.startswith("."):
                    continue  # local paths / VCS, not registry packages
                deps.append(self._dep(dep_name, None, i, False, Path(src)))

        parse(text, base, str(path) if path else "requirements.txt")
        return deps

    def _pipfile(self, data: dict, path: Path | None) -> list[Dependency]:
        deps = []
        for table in ("packages", "dev-packages"):
            for n, spec in (data.get(table) or {}).items():
                if isinstance(spec, dict):
                    if any(k in spec for k in ("git", "path", "file", "editable")):
                        continue  # VCS/local entries are not registry packages
                    version = spec.get("version")
                elif isinstance(spec, str):
                    version = spec
                else:
                    version = None
                deps.append(self._dep(n, version, 0, False, path))
        return deps

    def _toml(self, data: dict, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        project = data.get("project") or {}
        for spec in project.get("dependencies") or []:
            if isinstance(spec, str):
                n = _pep508_name(spec)
                if n:
                    deps.append(self._dep(n, None, 0, False, path))
        for group in (project.get("optional-dependencies") or {}).values():
            for spec in group or []:
                if isinstance(spec, str):
                    n = _pep508_name(spec)
                    if n:
                        deps.append(self._dep(n, None, 0, False, path))
        poetry = (data.get("tool") or {}).get("poetry") or {}
        for table in (poetry.get("dependencies") or {}, poetry.get("dev-dependencies") or {}):
            for n, spec in (table or {}).items():
                if n == "python":
                    continue
                if isinstance(spec, dict) and any(k in spec for k in ("git", "path", "url")):
                    continue
                deps.append(self._dep(n, None, 0, False, path))
        return deps

    def _setup_cfg(self, text: str, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        section = ""
        in_ir = False
        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if s.startswith("[") and s.endswith("]"):
                section = s[1:-1].strip()
                in_ir = False
                continue
            if section != "options":
                continue
            if s.startswith("install_requires"):
                in_ir = True
                rest = s.split("=", 1)[1].strip() if "=" in s else ""
                candidates = [rest] if rest else []
            elif in_ir:
                if not s or s.startswith(("#", ";")):
                    continue
                if not line.startswith((" ", "\t")):
                    in_ir = False
                    continue
                candidates = [s]
            else:
                continue
            for spec in candidates:
                n = _pep508_name(spec)
                if n:
                    deps.append(self._dep(n, None, i, False, path))
        return deps

    def _setup_py(self, text: str, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "setup":
                for kw in node.keywords:
                    if kw.arg == "install_requires" and isinstance(kw.value, (ast.List, ast.Tuple)):
                        for elt in kw.value.elts:
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                n = _pep508_name(elt.value)
                                if n:
                                    deps.append(self._dep(n, None, 0, False, path))
            elif isinstance(node, ast.Assign) and isinstance(node.value, (ast.List, ast.Tuple)):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == "install_requires":
                        for elt in node.value.elts:
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                n = _pep508_name(elt.value)
                                if n:
                                    deps.append(self._dep(n, None, 0, False, path))
        return deps


class JavaScriptAdapter(Adapter):
    language = "javascript"
    patterns = ("package.json", "package-lock.json")
    priority = 10
    registry_name = "npm"
    inline_marker = None  # JSON carries no comments; rely on .slopsquat-ignore

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        if name == "package-lock.json" and isinstance(data.get("packages"), dict):
            return self._lock_v2(data, path)
        if name == "package-lock.json":
            return self._lock_v1(data, path)
        deps = []
        for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            for n, v in (data.get(section) or {}).items():
                if isinstance(v, str) and v.startswith(
                    ("file:", "link:", "workspace:", "git+", "http://", "https://")
                ):
                    continue  # local/workspace/VCS/URL specs are not registry packages
                deps.append(self._dep(n, v if isinstance(v, str) else None, 0, False, path))
        return deps

    def _lock_v2(self, data: dict, path: Path | None) -> list[Dependency]:
        packages = data.get("packages") or {}
        root = packages.get("") or {}
        direct = set()
        for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            direct.update((root.get(section) or {}).keys())
        deps = []
        for pkg_path, entry in packages.items():
            if not pkg_path or not pkg_path.startswith("node_modules/"):
                continue
            if isinstance(entry, dict) and entry.get("link"):
                continue  # workspace link, not a registry package
            dep_name = pkg_path.split("node_modules/")[-1]
            top_level = pkg_path.count("node_modules/") == 1
            version = (entry or {}).get("version") if isinstance(entry, dict) else None
            deps.append(self._dep(dep_name, version, 0,
                                  (not top_level) or dep_name not in direct, path, 20))
        return deps

    def _lock_v1(self, data: dict, path: Path | None) -> list[Dependency]:
        deps = []

        def walk(entry: dict, transitive: bool) -> None:
            for n, spec in (entry.get("dependencies") or {}).items():
                version = (spec or {}).get("version") if isinstance(spec, dict) else None
                deps.append(self._dep(n, version, 0, transitive, path, 20))
                if isinstance(spec, dict):
                    walk(spec, True)

        walk(data, False)
        return deps


class GoAdapter(Adapter):
    language = "go"
    patterns = ("go.mod",)
    priority = 10
    registry_name = "go"
    inline_marker = "// slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        deps = []
        in_block = False
        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if s.startswith(("module ", "replace ", "exclude ")):
                continue
            if s.startswith("require"):
                rest = s[len("require"):].strip()
                if rest.startswith("("):
                    in_block = True
                    continue
                parts = rest.split()
                if len(parts) >= 2 and "// indirect" not in s:
                    deps.append(self._dep(parts[0], parts[1], i, False, path))
                continue
            if in_block:
                if s == ")":
                    in_block = False
                    continue
                if not s or s.startswith("//"):
                    continue
                parts = s.split()
                if len(parts) >= 2 and "// indirect" not in s:
                    deps.append(self._dep(parts[0], parts[1], i, False, path))
        return deps


class RustAdapter(Adapter):
    language = "rust"
    patterns = ("Cargo.toml", "Cargo.lock")
    priority = 10
    registry_name = "crates"
    inline_marker = "# slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "Cargo.lock":
            return self._lock(text, path)
        try:
            data = tomllib.loads(text)
        except tomllib.TOMLDecodeError:
            return []
        deps = []
        for section in ("dependencies", "dev-dependencies", "build-dependencies"):
            for n, spec in (data.get(section) or {}).items():
                if isinstance(spec, dict):
                    if spec.get("git") or spec.get("path"):
                        continue
                    version = spec.get("version")
                elif isinstance(spec, str):
                    version = spec
                else:
                    version = None
                deps.append(self._dep(n, version, 0, False, path))
        return deps

    def _lock(self, text: str, path: Path | None) -> list[Dependency]:
        blocks = re.split(r"^\[\[package\]\]\s*$", text, flags=re.M)
        packages: list[tuple[str, str | None]] = []
        referenced: set[str] = set()
        for block in blocks[1:]:
            nm = re.search(r'^name = "([^"]+)"', block, flags=re.M)
            vm = re.search(r'^version = "([^"]+)"', block, flags=re.M)
            if not nm:
                continue
            packages.append((nm.group(1), vm.group(1) if vm else None))
            head, sep, tail = block.partition("dependencies = [")
            if sep:
                refs = re.findall(r'"([^"]+)"', tail.split("]", 1)[0])
                for r in refs:
                    referenced.add(r.split()[0])
        deps = []
        for n, v in packages:
            deps.append(self._dep(n, v, 0, n in referenced, path, 20))
        return deps


class JavaAdapter(Adapter):
    language = "java"
    patterns = ("pom.xml", "build.gradle", "build.gradle.kts")
    priority = 10
    registry_name = "maven"
    inline_marker = "<!-- slopsquat-ignore -->"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "pom.xml":
            return self._pom(text, path)
        return self._gradle(text, path)

    def _pom(self, text: str, path: Path | None) -> list[Dependency]:
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            return []
        deps = []
        for dep in root.iter():
            if _local(dep.tag) != "dependency":
                continue
            group = artifact = version = None
            for child in dep:
                t = _local(child.tag)
                if t == "groupId":
                    group = (child.text or "").strip() or None
                elif t == "artifactId":
                    artifact = (child.text or "").strip() or None
                elif t == "version":
                    version = (child.text or "").strip() or None
            if group and artifact:
                deps.append(self._dep(f"{group}:{artifact}", version, 0, False, path))
        return deps

    def _gradle(self, text: str, path: Path | None) -> list[Dependency]:
        configs = (
            "implementation", "api", "compileOnly", "runtimeOnly",
            "testImplementation", "annotationProcessor", "compile",
        )
        deps = []
        lines = text.splitlines()
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            m = re.match(r"^(?:" + "|".join(configs) + r")\s*(\()(.*)$", line)
            if m:
                buf = m.group(2)
                depth = 1
                while depth > 0 and i < len(lines) - 1:
                    i += 1
                    depth += lines[i].count("(") - lines[i].count(")")
                    buf += " " + lines[i].strip()
                arg = buf.rstrip(")").strip()
            else:
                m = re.match(r"^(?:" + "|".join(configs) + r")\s+(.+)$", line)
                arg = m.group(1).strip() if m else None
            if arg:
                parsed = self._gradle_arg(arg)
                if parsed:
                    deps.append(self._dep(*parsed, i + 1, False, path))
            i += 1
        return deps

    @staticmethod
    def _gradle_arg(arg: str):
        q = re.match(r"^(['\"])([^'\"]+)\1$", arg.strip())
        if q:
            parts = q.group(2).split(":")
            if len(parts) >= 2:
                return f"{parts[0]}:{parts[1]}", parts[2] if len(parts) > 2 else None
            return None
        gm = re.search(r"group\s*:\s*['\"]([^'\"]+)['\"]", arg)
        nm = re.search(r"name\s*:\s*['\"]([^'\"]+)['\"]", arg)
        vm = re.search(r"version\s*:\s*['\"]([^'\"]+)['\"]", arg)
        if gm and nm:
            return f"{gm.group(1)}:{nm.group(1)}", vm.group(1) if vm else None
        return None


class DotnetAdapter(Adapter):
    language = "dotnet"
    patterns = ("*.csproj", "*.fsproj", "*.vbproj", "packages.config", "Directory.Packages.props")
    priority = 10
    registry_name = "nuget"
    inline_marker = "<!-- slopsquat-ignore -->"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "packages.config":
            return self._packages_config(text, path)
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            return []
        deps = []
        central = name == "Directory.Packages.props"
        for el in root.iter():
            tag = _local(el.tag)
            if central and tag == "PackageVersion":
                include = el.get("Include") or el.get("Update")
                if include:
                    deps.append(self._dep(include, el.get("Version"), 0, False, path, 15))
            elif not central and tag == "PackageReference":
                include = el.get("Include")
                if include:
                    deps.append(self._dep(include, el.get("Version"), 0, False, path))
        return deps

    def _packages_config(self, text: str, path: Path | None) -> list[Dependency]:
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            return []
        deps = []
        for el in root.iter():
            if _local(el.tag) == "package":
                pid = el.get("id")
                if pid:
                    deps.append(self._dep(pid, el.get("version"), 0, False, path))
        return deps


class CppAdapter(Adapter):
    language = "cpp"
    patterns = ("vcpkg.json", "conanfile.txt", "conanfile.py", "conan.lock")
    priority = 10
    registry_name = "vcpkg"  # existence via vcpkg or ConanCenter
    age_supported = False  # neither vcpkg nor ConanCenter stores release dates
    inline_marker = "# slopsquat-ignore"

    def detect(self, rel: Path, text: str) -> bool:
        name = rel.name
        if name in ("vcpkg.json", "conanfile.txt", "conan.lock"):
            return True
        if name == "conanfile.py":
            return "conan" in text or "requires" in text
        return False

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "vcpkg.json":
            return self._vcpkg(text, path)
        if name == "conanfile.txt":
            return self._conan_txt(text, path)
        if name == "conanfile.py":
            return self._conan_py(text, path)
        if name == "conan.lock":
            return self._conan_lock(text, path)
        return []

    def _vcpkg(self, text: str, path: Path | None) -> list[Dependency]:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        deps = []
        for section in ("dependencies", "host-dependencies"):
            for entry in data.get(section) or []:
                if isinstance(entry, str):
                    deps.append(self._dep(entry, None, 0, False, path, registry_name="vcpkg"))
                elif isinstance(entry, dict) and entry.get("name"):
                    deps.append(self._dep(entry["name"], entry.get("version"), 0, False, path,
                                          registry_name="vcpkg"))
        return deps

    def _conan_txt(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        section = None
        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if s.startswith("["):
                section = s.strip("[]")
                continue
            if section == "requires" and s and not s.startswith("#"):
                deps.append(self._dep(s.split("/")[0].strip(), None, i, False, path,
                                      registry_name="conan"))
        return deps

    def _conan_py(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        for m in re.finditer(r"requires\s*=\s*(?:\(|\[)?([^)\]#]*)(?:\)|\])?", text):
            for tok in re.findall(r"['\"]([^'\"]+)['\"]", m.group(1)):
                name = tok.split("/")[0].strip()
                if name:
                    deps.append(self._dep(name, None, 0, False, path, registry_name="conan"))
        return deps

    def _conan_lock(self, text: str, path: Path | None) -> list[Dependency]:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        deps: list[Dependency] = []

        def walk(obj) -> None:
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if k in ("requires", "build_requires") and isinstance(v, list):
                        for item in v:
                            ref = item.get("ref") if isinstance(item, dict) else item
                            if isinstance(ref, str) and "/" in ref:
                                deps.append(self._dep(ref.split("/")[0], None, 0, False, path,
                                                      registry_name="conan"))
                    else:
                        walk(v)
            elif isinstance(obj, list):
                for v in obj:
                    walk(v)

        walk(data)
        return deps


class RubyAdapter(Adapter):
    language = "ruby"
    patterns = ("Gemfile", "Gemfile.lock", "*.gemspec")
    priority = 10
    registry_name = "rubygems"
    inline_marker = "# slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "Gemfile.lock":
            return self._lock(text, path)
        if name == "Gemfile":
            return self._gemfile(text, path)
        return self._gemspec(text, path)

    def _gemfile(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        for i, line in enumerate(text.splitlines(), 1):
            m = re.match(r"^gem\s+(['\"])([^'\"]+)\1(.*)$", line.strip())
            if not m:
                continue
            if re.search(r"(^|,)\s*(git|path|github)\s*:", m.group(3)):
                continue  # git/path gems are not registry-checked
            deps.append(self._dep(m.group(2), None, i, False, path))
        return deps

    def _lock(self, text: str, path: Path | None) -> list[Dependency]:
        lines = text.splitlines()
        # DEPENDENCIES section (bottom of file) names the direct gems; pre-scan it.
        direct: set[str] = set()
        in_deps = False
        for line in lines:
            if not line.strip():
                continue
            if not line[0].isspace():
                in_deps = line.rstrip(":").strip() == "DEPENDENCIES"
                continue
            if in_deps:
                m = re.match(r"^\s{2}(\S+)", line)
                if m:
                    direct.add(m.group(1))
        deps = []
        section = ""
        in_specs = False
        for i, line in enumerate(lines, 1):
            if not line.strip():
                continue
            if not line[0].isspace():
                section = line.rstrip(":").strip()
                in_specs = False
                continue
            if section != "GEM":
                continue  # GIT/PATH gems are not registry-checked
            if line.strip() == "specs:":
                in_specs = True
                continue
            if in_specs:
                m = re.match(r"^ {4}(\S+) \(([^)]+)\)", line)
                if m:
                    deps.append(self._dep(m.group(1), m.group(2), i,
                                          m.group(1) not in direct, path, 20))
        return deps

    def _gemspec(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        for m in re.finditer(
            r"add_(?:runtime_|development_)?dependency\s*\(?\s*['\"]([^'\"]+)['\"]", text
        ):
            deps.append(self._dep(m.group(1), None, 0, False, path))
        return deps


class PhpAdapter(Adapter):
    language = "php"
    patterns = ("composer.json", "composer.lock")
    priority = 10
    registry_name = "packagist"
    inline_marker = None  # JSON carries no comments

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return []
        name = path.name if path else ""
        if name == "composer.lock":
            deps = []
            for section in ("packages", "packages-dev"):
                for pkg in data.get(section) or []:
                    if isinstance(pkg, dict) and pkg.get("name"):
                        deps.append(self._dep(pkg["name"], pkg.get("version"), 0, False, path, 20))
            return deps
        deps = []
        for section in ("require", "require-dev"):
            for n, v in (data.get(section) or {}).items():
                if n == "php" or n.startswith("ext-") or n.startswith("lib-"):
                    continue  # virtual packages, no Packagist lookup
                deps.append(self._dep(n, v if isinstance(v, str) else None, 0, False, path))
        return deps


class SwiftAdapter(Adapter):
    language = "swift"
    patterns = ("Package.swift",)
    priority = 10
    registry_name = "swift"
    age_supported = False  # no central registry with dates; existence via SPI
    inline_marker = "// slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        deps = []
        for m in re.finditer(r'\.package\s*\(\s*url\s*:\s*"([^"]+)"', text):
            url = m.group(1).rstrip("/")
            if url.endswith(".git"):
                url = url[:-4]
            gm = re.search(r"github\.com/([^/]+)/([^/]+)", url)
            if gm:
                deps.append(self._dep(f"{gm.group(1)}/{gm.group(2)}", None, 0, False, path))
            # non-github URLs: best effort, no SPI lookup possible
        return deps


class DartAdapter(Adapter):
    language = "dart"
    patterns = ("pubspec.yaml", "pubspec.lock")
    priority = 10
    registry_name = "pub"
    inline_marker = "# slopsquat-ignore"

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if name == "pubspec.lock":
            return self._lock(text, path)
        return self._yaml(text, path)

    def _yaml(self, text: str, path: Path | None) -> list[Dependency]:
        """Minimal indentation-aware parser for dependencies/dev_dependencies."""
        deps = []
        section = None
        cur: list | None = None
        lines = text.splitlines()

        def flush() -> None:
            nonlocal cur
            if cur and not cur[2]:
                deps.append(self._dep(cur[0], None, cur[1], False, path))
            cur = None

        for i, line in enumerate(lines, 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            indent = len(line) - len(line.lstrip())
            s = line.strip()
            if indent == 0:
                flush()
                key = s.split(":", 1)[0].strip()
                section = key if key in ("dependencies", "dev_dependencies") else None
                continue
            if section is None:
                continue
            if indent == 2:
                flush()
                m = re.match(r"^([A-Za-z0-9_\-\.]+)\s*:\s*(.*)$", s)
                if not m:
                    continue
                value = m.group(2).strip()
                if value and not value.startswith("#"):
                    deps.append(self._dep(m.group(1), value, i, False, path))
                else:
                    cur = [m.group(1), i, False]
            elif indent >= 4 and cur is not None:
                key = s.split(":", 1)[0].strip()
                if key in ("git", "path", "sdk"):
                    cur[2] = True
        flush()
        return deps

    def _lock(self, text: str, path: Path | None) -> list[Dependency]:
        deps = []
        in_packages = False
        cur: list | None = None

        def flush() -> None:
            nonlocal cur
            if cur:
                dep_type = cur[2]
                direct = dep_type is None or dep_type.startswith("direct")
                deps.append(self._dep(cur[0], cur[3], cur[1], not direct, path, 20))
            cur = None

        for i, line in enumerate(text.splitlines(), 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            indent = len(line) - len(line.lstrip())
            s = line.strip()
            if indent == 0:
                flush()
                in_packages = s.split(":", 1)[0].strip() == "packages"
                continue
            if not in_packages:
                continue
            if indent == 2:
                flush()
                m = re.match(r"^([A-Za-z0-9_\-\.]+)\s*:", s)
                if m:
                    cur = [m.group(1), i, None, None]
            elif indent == 4 and cur is not None:
                k, _, v = s.partition(":")
                k = k.strip()
                v = v.strip().strip('"')
                if k == "dependency":
                    cur[2] = v
                elif k == "version":
                    cur[3] = v
        flush()
        return deps


ADAPTERS: list[Adapter] = [
    PythonAdapter(),
    JavaScriptAdapter(),
    GoAdapter(),
    RustAdapter(),
    JavaAdapter(),
    DotnetAdapter(),
    CppAdapter(),
    RubyAdapter(),
    PhpAdapter(),
    SwiftAdapter(),
    DartAdapter(),
]


# ─── core pipeline ──────────────────────────────────────────────────


def _prefer(a: Dependency, b: Dependency) -> bool:
    """Dedupe winner: direct over transitive, then higher adapter priority."""
    if a.transitive != b.transitive:
        return not a.transitive
    return a.priority > b.priority


def run_check(root: Path, fetcher, threshold_days: int,
              check_transitive: bool, verbose: bool) -> dict:
    matcher = GitignoreMatcher(root)
    ignore = IgnoreFilter(root)
    adapter_by_lang = {a.language: a for a in ADAPTERS}

    # Cheap basename pre-filter: only read files whose name could match a
    # manifest pattern (avoids slurping every file in large trees).
    def candidate_filename(rel: Path) -> bool:
        return any(fnmatch.fnmatchcase(rel.name, p)
                   for a in ADAPTERS for p in a.patterns)

    collected: list[Dependency] = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = Path(dirpath).relative_to(root)
        matcher.load_dir(Path(dirpath))
        kept = []
        for d in sorted(dirnames):
            if d in ALWAYS_SKIP_DIRS:
                continue
            rel_d = rel_dir / d
            if matcher.matches(rel_d, is_dir=True):
                continue
            kept.append(d)
        dirnames[:] = kept
        for fn in filenames:
            rel_f = rel_dir / fn
            if matcher.matches(rel_f, is_dir=False):
                continue
            if not candidate_filename(rel_f):
                continue
            full = Path(dirpath) / fn
            try:
                text = full.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for adapter in ADAPTERS:
                if adapter.detect(rel_f, text):
                    collected.extend(adapter.extract(text, full))
                    break

    # Relativize paths, resolve unknown line numbers, apply inline markers.
    file_lines: dict[str, list[str]] = {}

    def lines_of(src: str) -> list[str]:
        if src not in file_lines:
            try:
                file_lines[src] = (root / src).read_text(
                    encoding="utf-8", errors="replace"
                ).splitlines()
            except OSError:
                file_lines[src] = []
        return file_lines[src]

    deps: list[Dependency] = []
    for dep in collected:
        try:
            rel = os.path.relpath(dep.source_file, root) if dep.source_file else ""
        except ValueError:
            rel = dep.source_file
        dep.source_file = rel
        if dep.line == 0:
            probes = [dep.name]
            if ":" in dep.name:
                probes.append(dep.name.split(":", 1)[1])
            elif "/" in dep.name:
                probes.append(dep.name.rsplit("/", 1)[-1])
            for idx, ln in enumerate(lines_of(rel), 1):
                if any(p in ln for p in probes):
                    dep.line = idx
                    break
        marker = adapter_by_lang[dep.language].inline_marker
        if marker and dep.line > 0:
            ls = lines_of(rel)
            if dep.line <= len(ls) and marker in ls[dep.line - 1]:
                continue  # inline slopsquat-ignore marker
        if ignore.ignored(dep.language, dep.name):
            continue
        deps.append(dep)

    # Dedupe by (language, name); lockfiles preferred via priority.
    selected: dict[tuple[str, str], Dependency] = {}
    for dep in deps:
        if check_transitive or not dep.transitive:
            key = (dep.language, dep.name)
            cur = selected.get(key)
            if cur is None or _prefer(dep, cur):
                selected[key] = dep

    registries: dict[str, Registry] = {
        rname: rcls(fetcher) for rname, rcls in REGISTRIES.items()
    }

    checked: list[dict] = []
    failures: list[dict] = []
    for (lang, name), dep in selected.items():
        adapter = adapter_by_lang[lang]
        registry = registries[dep.registry_name or adapter.registry_name]
        try:
            record = registry.check(name)
        except RegistryError as e:
            failures.append(_failure(dep, "registry-unreachable", str(e)))
            continue
        if not record.exists:
            failures.append(_failure(
                dep, "not-found",
                f"Package {name!r} does not exist in the {registry.name} registry",
            ))
            continue
        age_days = None
        if adapter.age_supported:
            age_days = days_since(record.earliest_release_iso)
            if age_days is None:
                failures.append(_failure(
                    dep, "too-young",
                    f"Package {name!r}: registry returned no parseable release date — "
                    f"cannot verify age (fail-closed)",
                ))
                continue
            if threshold_days > 0 and age_days < threshold_days:
                failures.append(_failure(
                    dep, "too-young",
                    f"Package {name!r} is {age_days} days old — below "
                    f"{threshold_days}-day safety threshold",
                ))
                continue
        checked.append({
            "language": dep.language,
            "name": dep.name,
            "version": dep.version,
            "age_days": age_days,
            "source_file": dep.source_file,
            "line": dep.line,
        })

    if verbose:
        for c in checked:
            print(f"  ok  {c['language']}:{c['name']} "
                  f"(v={c['version'] or '?'}, age={c['age_days']}d) "
                  f"[{c['source_file']}:{c['line']}]", file=sys.stderr)
        for f in failures:
            print(f"  FAIL {f['language']}:{f['name']} ({f['reason']}) "
                  f"[{f['source_file']}:{f['line']}]", file=sys.stderr)

    return {
        "ok": len(failures) == 0,
        "threshold_days": threshold_days,
        "checked": checked,
        "failures": failures,
        "cache": {
            "hits": getattr(fetcher.stats, "hits", 0),
            "misses": getattr(fetcher.stats, "misses", 0),
            "requests": getattr(fetcher.stats, "requests", 0),
        },
    }


def _failure(dep: Dependency, reason: str, message: str) -> dict:
    return {
        "language": dep.language,
        "name": dep.name,
        "version": dep.version,
        "reason": reason,
        "message": message,
        "source_file": dep.source_file,
        "line": dep.line,
    }


def main(argv: list[str] | None = None, fetcher=None) -> int:
    parser = argparse.ArgumentParser(
        prog="dependency-existence-check",
        description="Check that declared dependencies exist in their registries "
                    "and are older than the safety threshold.",
    )
    parser.add_argument("--root", default=".", help="repository root (default: .)")
    parser.add_argument("--json", action="store_true", help="emit JSON report")
    parser.add_argument("--cache-dir", default=None,
                        help="directory for ETag/response cache (default: ~/.cache/slopsquat)")
    parser.add_argument("--threshold-days", type=int, default=SAFETY_THRESHOLD_DAYS,
                        help="minimum package age in days (0 disables the age guard)")
    parser.add_argument("--check-transitive", action="store_true",
                        help="also check transitive dependencies from lockfiles")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)  # unknown flags -> exit 2

    root = Path(args.root)
    if not root.is_dir():
        print(f"error: --root {args.root!r} is not a readable directory", file=sys.stderr)
        return 2
    if args.threshold_days < 0:
        print("error: --threshold-days must be >= 0", file=sys.stderr)
        return 2

    if fetcher is None:
        cache_dir = args.cache_dir or os.path.join(
            os.path.expanduser("~"), ".cache", "slopsquat")
        fetcher = RealFetcher(cache_dir)

    report = run_check(root, fetcher, args.threshold_days,
                       args.check_transitive, args.verbose)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"Dependency existence check ({report['threshold_days']}-day threshold): "
              f"{len(report['checked'])} checked, {len(report['failures'])} finding(s)")
        for f in report["failures"]:
            loc = f"{f['source_file']}:{f['line']}" if f["source_file"] else "(unknown)"
            print(f"  FAIL {f['language']}:{f['name']} — {f['message']} [{loc}]")

    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
