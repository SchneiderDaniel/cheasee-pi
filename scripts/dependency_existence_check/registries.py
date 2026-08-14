"""One registry client per package registry, plus the REGISTRIES table."""

from __future__ import annotations

import datetime
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import timezone

from dependency_existence_check.helpers import _local
from dependency_existence_check.models import PackageRecord, RegistryError
from dependency_existence_check.transport import RateLimiter


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
        # /api/v1/gems/{name}.json no longer exposes a release date; the
        # versions endpoint carries per-version built_at timestamps.
        return f"https://rubygems.org/api/v1/versions/{urllib.parse.quote(name, safe='')}.json"

    def _parse(self, name: str, status: int, body: str) -> PackageRecord:
        if status == 404 or not body:
            return PackageRecord(False)
        try:
            data = json.loads(body)
        except json.JSONDecodeError as e:
            raise RegistryError(f"malformed JSON response for {name}: {e}") from None
        if not isinstance(data, list):
            raise RegistryError(f"unexpected response shape for {name}")
        times = [v.get("built_at") for v in data
                 if isinstance(v, dict) and v.get("built_at")]
        if not times:
            return PackageRecord(True, None)  # core age guard fails closed
        return PackageRecord(True, min(times))


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
