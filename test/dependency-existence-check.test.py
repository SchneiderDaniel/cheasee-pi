#!/usr/bin/env python3
"""Offline test suite for scripts/dependency-existence-check.py.

No network: every test injects a FakeFetcher (via main(argv, fetcher=...)) that
raises AssertionError on unregistered URLs, so an accidental real registry call
fails the test instead of silently skipping. The cache/ETag tests exercise the
real DiskCache/RealFetcher against a fake transport.

Run:  python3 test/dependency-existence-check.test.py
"""

import contextlib
import importlib.util
import io
import json
import re
import sys
import tempfile
import time
import unittest
import urllib.parse
from datetime import datetime as _dt, timedelta, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SCRIPTS = _HERE.parent / "scripts"
_spec = importlib.util.spec_from_file_location(
    "dependency_existence_check", _SCRIPTS / "dependency-existence-check.py")
dec = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
sys.modules["dependency_existence_check"] = dec  # dataclass machinery requires it
_spec.loader.exec_module(dec)

OLD_ISO = "2020-01-01T00:00:00Z"  # ancient: always passes the 14-day guard


def iso_days_ago(days):
    return (_dt.now(timezone.utc) - timedelta(days=days)).isoformat()


def pypi_body(iso=OLD_ISO):
    return json.dumps({"info": {"name": "x"},
                       "releases": {"0.1.0": [{"upload_time": iso}]}})


def run_main(args, fetcher):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = dec.main(args, fetcher=fetcher)
    return code, buf.getvalue()


def url_for(registry, name):
    """Expected registry URL for a package name (mirrors the script's table)."""
    if registry == "pypi":
        return f"https://pypi.org/pypi/{name}/json"
    if registry == "npm":
        return f"https://registry.npmjs.org/{urllib.parse.quote(name, safe='@')}"
    if registry == "go":
        n = re.sub(r"[A-Z]", lambda m: "!" + m.group(0).lower(), name)
        return f"https://proxy.golang.org/{n}/@latest"
    if registry == "crates":
        return f"https://crates.io/api/v1/crates/{name}"
    if registry == "maven":
        g, a = name.split(":", 1)
        return f"https://repo1.maven.org/maven2/{g.replace('.', '/')}/{a}/maven-metadata.xml"
    if registry == "maven-version":
        g, a = name.split(":", 1)
        return (f"https://repo1.maven.org/maven2/{g.replace('.', '/')}/{a}/"
                f"1.0.0/maven-metadata.xml")
    if registry == "nuget":
        return f"https://api.nuget.org/v3/registration5-semver1/{name.lower()}/index.json"
    if registry == "vcpkg":
        return f"https://raw.githubusercontent.com/microsoft/vcpkg/master/ports/{name}/vcpkg.json"
    if registry == "conan":
        return f"https://conan.io/center/recipes/{name}"
    if registry == "rubygems":
        return f"https://rubygems.org/api/v1/gems/{name}.json"
    if registry == "packagist":
        return f"https://repo.packagist.org/p2/{name}.json"
    if registry == "swift":
        return f"https://swiftpackageindex.com/{name}"
    if registry == "pub":
        return f"https://pub.dev/api/packages/{name}"
    raise AssertionError(f"unknown registry {registry}")


def ok_route(registry, name, iso=OLD_ISO):
    url = url_for(registry, name)
    if registry == "pypi":
        return url, (200, pypi_body(iso), None)
    if registry == "npm":
        return url, (200, json.dumps({"time": {"created": iso}}), None)
    if registry == "go":
        return url, (200, json.dumps({"Version": "v1.0.0", "Time": iso}), None)
    if registry == "crates":
        return url, (200, json.dumps({"crate": {"created_at": iso}}), None)
    if registry == "maven":
        return url, (200, (
            "<metadata><groupId>g</groupId><artifactId>a</artifactId><versioning>"
            "<latest>1.0.0</latest><versions><version>1.0.0</version></versions>"
            "</versioning></metadata>"), None)
    if registry == "maven-version":
        return url, (200, (
            "<metadata><groupId>g</groupId><artifactId>a</artifactId><version>1.0.0</version>"
            "<versioning><lastUpdated>20200101000000</lastUpdated></versioning></metadata>"), None)
    if registry == "nuget":
        return url, (200, json.dumps(
            {"items": [{"catalogEntry": {"published": iso}}]}), None)
    if registry == "vcpkg":
        return url, (200, json.dumps({"name": name}), None)
    if registry == "conan":
        return url, (200, "<html>recipe</html>", None)
    if registry == "rubygems":
        return url, (200, json.dumps({"created_at": iso}), None)
    if registry == "packagist":
        return url, (200, json.dumps(
            {"packages": {name: [{"name": name, "time": iso}]}}), None)
    if registry == "swift":
        return url, (200, "<html>ok</html>", None)
    if registry == "pub":
        return url, (200, json.dumps({"versions": [{"published": iso}]}), None)
    raise AssertionError(f"unknown registry {registry}")


def not_found_route(registry, name):
    url = url_for(registry, name)
    return url, (404, "", None)


def make_response(url, etag=None):
    """Permissive default handler: any registry URL answers 200 with an old date."""
    if "pypi.org/pypi/" in url:
        return 200, pypi_body(), None
    if "registry.npmjs.org/" in url:
        return 200, json.dumps({"time": {"created": OLD_ISO}}), None
    if "proxy.golang.org/" in url:
        return 200, json.dumps({"Version": "v1.0.0", "Time": OLD_ISO}), None
    if "crates.io/api/v1/crates/" in url:
        return 200, json.dumps({"crate": {"created_at": OLD_ISO}}), None
    if "repo1.maven.org/maven2/" in url:
        if re.search(r"/[^/]+/maven-metadata\.xml$", url):
            return 200, ("<metadata><versioning><lastUpdated>20200101000000"
                         "</lastUpdated></versioning></metadata>"), None
        return 200, ("<metadata><versioning><versions><version>1.0.0</version>"
                     "</versions></versioning></metadata>"), None
    if "api.nuget.org/v3/registration5-semver1/" in url:
        return 200, json.dumps(
            {"items": [{"catalogEntry": {"published": OLD_ISO}}]}), None
    if "raw.githubusercontent.com/microsoft/vcpkg/" in url:
        return 200, json.dumps({"name": "x"}), None
    if "conan.io/center/recipes/" in url:
        return 200, "<html>recipe</html>", None
    if "rubygems.org/api/v1/gems/" in url:
        return 200, json.dumps({"created_at": OLD_ISO}), None
    if "repo.packagist.org/p2/" in url:
        return 200, json.dumps({"packages": {"x/y": [{"time": OLD_ISO}]}}), None
    if "swiftpackageindex.com/" in url:
        return 200, "<html>ok</html>", None
    if "pub.dev/api/packages/" in url:
        return 200, json.dumps({"versions": [{"published": OLD_ISO}]}), None
    raise AssertionError(f"unhandled registry URL in default handler: {url}")


class FakeFetcher:
    """Fetcher contract stand-in: route table, request log, etag/304, errors."""

    class _Stats:
        def __init__(self):
            self.hits = 0
            self.misses = 0
            self.requests = 0

    def __init__(self, routes=None, default=None, cache=None):
        self.routes = dict(routes or {})
        self.default = default
        self.cache = dict(cache or {})
        self.log = []  # (url, etag) per network request
        self.stats = FakeFetcher._Stats()

    def cache_entry(self, url):
        return self.cache.get(url)

    def get(self, url, etag=None):
        entry = self.cache.get(url)
        if entry is not None and etag is None:
            self.stats.hits += 1
            return entry
        if url in self.routes:
            status, body, new_etag = self.routes[url]
            if callable(status):
                status, body, new_etag = status()
            self.log.append((url, etag))
            if status == 304 and entry is not None:
                self.stats.hits += 1
                return entry
            self.stats.misses += 1
            self.stats.requests += 1
            result = (status, body, new_etag)
            if status < 500:  # never cache transient 5xx: retries must re-hit
                self.cache[url] = result
            return result
        if self.default is not None:
            result = self.default(url, etag)
            if result is not None:
                self.log.append((url, etag))
                self.stats.misses += 1
                self.stats.requests += 1
                if result[0] < 500:
                    self.cache[url] = result
                return result
        raise AssertionError(f"unregistered URL: {url}")

    def requested_urls(self):
        return [u for u, _ in self.log]


def write_repo(files):
    """Create a temp repo dir from {relpath: content}; returns (TemporaryDirectory, Path)."""
    td = tempfile.TemporaryDirectory()
    repo = Path(td.name) / "repo"
    repo.mkdir()
    for rel, content in files.items():
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    return td, repo


class PipelineAndAgeGuardTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def _run_py_dep(self, published, threshold=None, name="alpha"):
        td, repo = write_repo({"requirements.txt": f"{name}\n"})
        try:
            fetcher = FakeFetcher(routes=dict([
                ok_route("pypi", name, published),
            ]))
            args = ["--root", str(repo), "--json"]
            if threshold is not None:
                args += ["--threshold-days", str(threshold)]
            code, out = run_main(args, fetcher)
            return code, json.loads(out)
        finally:
            td.cleanup()

    def test_age_guard_boundary(self):
        code, r = self._run_py_dep(iso_days_ago(14))
        self.assertEqual(code, 0)
        self.assertTrue(r["ok"])
        code, r = self._run_py_dep(iso_days_ago(13))
        self.assertEqual(code, 1)
        self.assertEqual(r["failures"][0]["reason"], "too-young")
        code, r = self._run_py_dep(iso_days_ago(0))
        self.assertEqual(code, 1)
        self.assertEqual(r["failures"][0]["reason"], "too-young")
        code, r = self._run_py_dep(iso_days_ago(-1))  # future-dated
        self.assertEqual(code, 1)
        self.assertEqual(r["failures"][0]["reason"], "too-young")

    def test_days_since_floor_semantics(self):
        self.assertEqual(dec.days_since(iso_days_ago(13.99)), 13)
        self.assertEqual(dec.days_since(iso_days_ago(14)), 14)
        self.assertIsNone(dec.days_since(""))
        self.assertIsNone(dec.days_since("not-a-date"))

    def test_age_guard_skipped_for_date_less_registries(self):
        # vcpkg/conan/swift expose no dates; existence remains authoritative.
        td, repo = write_repo({
            "vcpkg.json": json.dumps({"dependencies": ["zlib", "libpng"]}),
            "conanfile.txt": "[requires]\nopenssl/3.0.0\n",
            "Package.swift": (
                '// swift-tools-version:5.9\n'
                'import PackageDescription\n'
                'let p = Package(name: "x", dependencies: [\n'
                '    .package(url: "https://github.com/owner/libfoo.git", from: "1.0.0"),\n'
                '])\n'),
        })
        try:
            fetcher = FakeFetcher(routes=dict([
                ok_route("vcpkg", "zlib"), ok_route("vcpkg", "libpng"),
                ok_route("conan", "openssl"),
                ok_route("swift", "owner/libfoo"),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertTrue(r["ok"])
            for c in r["checked"]:
                self.assertIsNone(c["age_days"])  # no date field required
        finally:
            td.cleanup()

    def test_missing_date_fail_closed(self):
        # Date-capable registry answers 200 but with no parseable date -> too-young.
        url, _ = ok_route("pypi", "alpha")
        td, repo = write_repo({"requirements.txt": "alpha\n"})
        try:
            fetcher = FakeFetcher(routes={
                url: (200, json.dumps({"releases": {"0.1.0": [{"upload_time": None}]}}), None),
            })
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            f = r["failures"][0]
            self.assertEqual(f["reason"], "too-young")
            self.assertIn("cannot verify age", f["message"])
        finally:
            td.cleanup()

    def test_cli_usage_errors_exit_2(self):
        with self.assertRaises(SystemExit) as cm:
            dec.main(["--bogus-flag"])
        self.assertEqual(cm.exception.code, 2)
        self.assertEqual(dec.main(["--root", "/definitely/not/a/real/path"]), 2)
        self.assertEqual(dec.main(["--root", "/definitely/not/a/real/path", "--json"]), 2)

    def test_json_report_contract(self):
        td, repo = write_repo({"requirements.txt": "alpha\nbeta\n"})
        try:
            fetcher = FakeFetcher(routes=dict([
                ok_route("pypi", "alpha"), ok_route("pypi", "beta"),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            for key in ("ok", "threshold_days", "checked", "failures", "cache"):
                self.assertIn(key, r)
            self.assertEqual(r["threshold_days"], 14)
            self.assertEqual(len(r["checked"]), 2)
            self.assertEqual(r["failures"], [])
            self.assertEqual(set(r["cache"]), {"hits", "misses", "requests"})
            for c in r["checked"]:
                for key in ("language", "name", "version", "age_days",
                            "source_file", "line"):
                    self.assertIn(key, c)
        finally:
            td.cleanup()

    def test_threshold_override(self):
        code, r = self._run_py_dep(iso_days_ago(20), threshold=30)
        self.assertEqual(code, 1)
        self.assertEqual(r["failures"][0]["reason"], "too-young")
        code, r = self._run_py_dep(iso_days_ago(20), threshold=0)
        self.assertEqual(code, 0)
        self.assertTrue(r["ok"])

    def test_no_manifests_exit_zero(self):
        td, repo = write_repo({"README.md": "nothing to see here\n"})
        try:
            fetcher = FakeFetcher()
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(r["checked"], [])
            self.assertEqual(r["failures"], [])
        finally:
            td.cleanup()

    def test_verbose_does_not_change_json_or_exit_code(self):
        td, repo = write_repo({"requirements.txt": "alpha\n"})
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json", "--verbose"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(len(r["checked"]), 1)
            self.assertIn("alpha", out)
        finally:
            td.cleanup()

    def test_cross_manifest_dedupe_one_request(self):
        td, repo = write_repo({
            "requirements.txt": "alpha==1.0\n",
            "pyproject.toml": '[project]\ndependencies = ["alpha>=2.0"]\n',
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(len(r["checked"]), 1)
            self.assertEqual(len(fetcher.requested_urls()), 1)
        finally:
            td.cleanup()


class DiscoveryAndGitignoreTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def test_gitignore_matcher_pattern_classes(self):
        td, repo = write_repo({".gitignore": "\n".join([
            "# comment",
            "*.log",
            "build/",
            "/rooted.txt",
            "sub/keep.txt",
            "**/generated",
            "a/**/deep.txt",
            "doc?x.txt",
            "[ab].txt",
            "!keep.log",
            "",
        ])})
        try:
            m = dec.GitignoreMatcher(repo)
            m.load_dir(repo)
            # * unanchored, any depth
            self.assertTrue(m.matches(Path("a.log")))
            self.assertTrue(m.matches(Path("x/y/a.log")))
            self.assertFalse(m.matches(Path("x.txt")))
            # dir-only trailing /
            self.assertTrue(m.matches(Path("build"), is_dir=True))
            self.assertFalse(m.matches(Path("build"), is_dir=False))
            self.assertTrue(m.matches(Path("x/build"), is_dir=True))
            # /-anchored to root
            self.assertTrue(m.matches(Path("rooted.txt")))
            self.assertFalse(m.matches(Path("sub/rooted.txt")))
            # anchored path
            self.assertTrue(m.matches(Path("sub/keep.txt")))
            self.assertFalse(m.matches(Path("keep.txt")))
            self.assertFalse(m.matches(Path("other/sub/keep.txt")))
            # ** prefix
            self.assertTrue(m.matches(Path("generated")))
            self.assertTrue(m.matches(Path("a/b/generated")))
            self.assertFalse(m.matches(Path("generated.txt")))
            # ** mid
            self.assertTrue(m.matches(Path("a/x/y/deep.txt")))
            self.assertTrue(m.matches(Path("a/deep.txt")))
            self.assertFalse(m.matches(Path("b/deep.txt")))
            # ?
            self.assertTrue(m.matches(Path("docax.txt")))
            self.assertFalse(m.matches(Path("docx.txt")))
            # [...]
            self.assertTrue(m.matches(Path("a.txt")))
            self.assertFalse(m.matches(Path("c.txt")))
            # ! negation (with *.log above)
            self.assertFalse(m.matches(Path("keep.log")))
            self.assertTrue(m.matches(Path("drop.log")))
        finally:
            td.cleanup()

    def test_git_and_node_modules_always_skipped(self):
        td, repo = write_repo({
            ".gitignore": "!.git/**\n!node_modules/**\n",
            "node_modules/evil/package.json": json.dumps(
                {"dependencies": {"nope-js": "1.0.0"}}),
            ".git/package.json": json.dumps({"dependencies": {"nope-git": "1.0.0"}}),
            "package.json": json.dumps({"dependencies": {"alpha": "1.0.0"}}),
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("npm", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            names = {c["name"] for c in r["checked"]}
            self.assertEqual(names, {"alpha"})
        finally:
            td.cleanup()

    def test_manifests_detected_at_arbitrary_depth(self):
        td, repo = write_repo({"a/b/c/d/e/requirements.txt": "alpha\n"})
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(r["checked"][0]["source_file"], "a/b/c/d/e/requirements.txt")
        finally:
            td.cleanup()

    def test_content_sniffing_detection(self):
        # Pipfile / setup.py / conanfile.py need content sniffing, not just names.
        td, repo = write_repo({
            "Pipfile": '[packages]\nrequests = "*"\n',
            "setup.py": 'from setuptools import setup\n'
                        'setup(name="x", install_requires=["flask>=2.0"])\n',
            "conanfile.py": 'from conans import ConanFile\n'
                            'class X(ConanFile):\n    requires = "openssl/3.0.0"\n',
            "not-a-manifest.py": "print('hello')\n",  # negative case
        })
        try:
            fetcher = FakeFetcher(routes=dict([
                ok_route("pypi", "requests"), ok_route("pypi", "flask"),
                ok_route("conan", "openssl"),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0, r["failures"])
            names = {c["name"] for c in r["checked"]}
            self.assertEqual(names, {"requests", "flask", "openssl"})
        finally:
            td.cleanup()

    def test_gitignored_manifests_skipped(self):
        td, repo = write_repo({
            ".gitignore": "vendored/\nobj/\n",
            "vendored/package.json": json.dumps({"dependencies": {"vendored-js": "1.0.0"}}),
            "obj/App.csproj": "<Project><ItemGroup>"
                              '<PackageReference Include="obj-dotnet" /></ItemGroup></Project>',
            "package.json": json.dumps({"dependencies": {"alpha": "1.0.0"}}),
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("npm", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            names = {c["name"] for c in r["checked"]}
            self.assertEqual(names, {"alpha"})
        finally:
            td.cleanup()

    def test_lockfile_preferred_over_manifest(self):
        cases = [
            ("npm", {
                "package.json": json.dumps({"dependencies": {"alpha": "^1.0.0"}}),
                "package-lock.json": json.dumps({
                    "name": "root", "version": "1.0.0", "lockfileVersion": 3,
                    "packages": {
                        "": {"name": "root", "dependencies": {"alpha": "^1.0.0"}},
                        "node_modules/alpha": {"version": "1.2.3"},
                    },
                }),
            }, "alpha", "1.2.3"),
            ("crates", {
                "Cargo.toml": '[dependencies]\nalpha = "1"\n',
                "Cargo.lock": '[[package]]\nname = "alpha"\nversion = "1.5.0"\n',
            }, "alpha", "1.5.0"),
            ("rubygems", {
                "Gemfile": 'gem "alpha"\n',
                "Gemfile.lock": (
                    "GEM\n  remote: https://rubygems.org/\n  specs:\n"
                    "    alpha (2.0.0)\n\n"
                    "PLATFORMS\n  ruby\n\n"
                    "DEPENDENCIES\n  alpha\n"),
            }, "alpha", "2.0.0"),
            ("packagist", {
                "composer.json": json.dumps({"require": {"vendor/alpha": "^1.0"}}),
                "composer.lock": json.dumps({
                    "packages": [{"name": "vendor/alpha", "version": "1.3.0"}],
                }),
            }, "vendor/alpha", "1.3.0"),
            ("pub", {
                "pubspec.yaml": "name: x\ndependencies:\n  alpha: ^1.0.0\n",
                "pubspec.lock": (
                    "packages:\n  alpha:\n    dependency: \"direct main\"\n"
                    "    source: hosted\n    version: \"1.4.0\"\n"),
            }, "alpha", "1.4.0"),
        ]
        for reg, files, dep_name, lock_version in cases:
            td, repo = write_repo(files)
            try:
                fetcher = FakeFetcher(routes=dict([ok_route(reg, dep_name)]))
                code, out = run_main(["--root", str(repo), "--json"], fetcher)
                r = json.loads(out)
                self.assertEqual(code, 0, f"{reg}: {r['failures']}")
                self.assertEqual(len(r["checked"]), 1, reg)
                self.assertEqual(len(fetcher.requested_urls()), 1, reg)
                self.assertEqual(r["checked"][0]["version"], lock_version, reg)
            finally:
                td.cleanup()

    def test_non_manifest_lookalikes_ignored(self):
        td, repo = write_repo({
            "go.sum": "github.com/foo v1.0.0 h1:abc=\n",
            "node_modules/evil/package-lock.json": json.dumps({
                "packages": {"node_modules/evil": {"version": "1.0.0"}},
            }),
        })
        try:
            fetcher = FakeFetcher()  # no routes: any request fails the test
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(r["checked"], [])
        finally:
            td.cleanup()

    def test_transitive_off_by_default(self):
        pkgs = ["a", "b", "c", "d", "e", "f", "g"]
        lock = []
        for p in pkgs:
            block = f'[[package]]\nname = "{p}"\nversion = "1.0.0"\n'
            if p in ("a", "b"):
                block += "dependencies = [\n" + "\n".join(f' "{x}",' for x in pkgs[2:]) + "\n]\n"
            lock.append(block)
        td, repo = write_repo({"Cargo.lock": "\n".join(lock)})
        try:
            routes = dict([ok_route("crates", p) for p in pkgs])
            fetcher = FakeFetcher(routes=routes)
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(len(r["checked"]), 2)  # a, b direct only
            self.assertEqual(len(fetcher.requested_urls()), 2)
            fetcher2 = FakeFetcher(routes=routes)
            code2, out2 = run_main(["--root", str(repo), "--json", "--check-transitive"], fetcher2)
            r2 = json.loads(out2)
            self.assertEqual(code2, 0)
            self.assertEqual(len(r2["checked"]), 7)
            self.assertEqual(len(fetcher2.requested_urls()), 7)
        finally:
            td.cleanup()


class AdapterExtractionTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def names(self, adapter, text, path=None):
        return [(d.name, d.version) for d in adapter.extract(text, path)]

    @staticmethod
    def P(name):
        return Path(name)

    def test_python_requirements(self):
        a = dec.PythonAdapter()
        td = tempfile.TemporaryDirectory()
        try:
            inc = Path(td.name) / "constraints.txt"
            inc.write_text("urllib3==2.0.0\n")
            req = Path(td.name) / "requirements.txt"
            req.write_text(
                "# comment\n\n"
                "requests==2.31.0\n"
                "flask>=3.0\n"
                "click[extra]~=8.1\n"
                "-r constraints.txt\n"
                "-e git+https://github.com/x/y.git#egg=y\n"
                "git+https://github.com/x/z.git\n"
                "https://example.com/pkg.whl\n"
                "local_pkg; python_version < '3.12'\n"
            )
            deps = self.names(a, req.read_text(), req)
            names = {n for n, _ in deps}
            self.assertEqual(names, {"requests", "flask", "click", "urllib3", "local_pkg"})
        finally:
            td.cleanup()

    def test_python_pyproject_and_poetry(self):
        a = dec.PythonAdapter()
        text = (
            "[project]\n"
            'dependencies = ["requests>=2.0", "flask"]\n'
            "[project.optional-dependencies]\n"
            'test = ["pytest>=7", "coverage"]\n'
            "[tool.poetry.dependencies]\n"
            'python = "^3.11"\n'
            'requests = "^2.31"\n'
            'local = {path = "../local"}\n'
            "[tool.poetry.dev-dependencies]\n"
            'black = "*"\n'
        )
        names = {n for n, _ in self.names(a, text, self.P("pyproject.toml"))}
        self.assertEqual(names, {"requests", "flask", "pytest", "coverage", "black"})

    def test_python_pipfile(self):
        a = dec.PythonAdapter()
        text = (
            "[packages]\n"
            'requests = "*"\n'
            'flask = {version = "==3.0.0"}\n'
            'local = {path = "."}\n'
            'gitdep = {git = "https://x/y.git"}\n'
            "[dev-packages]\n"
            'pytest = "*"\n'
        )
        names = {n for n, _ in self.names(a, text, self.P("Pipfile"))}
        self.assertEqual(names, {"requests", "flask", "pytest"})

    def test_python_setup_cfg_and_setup_py(self):
        a = dec.PythonAdapter()
        cfg = "[options]\ninstall_requires =\n    requests>=2.0\n    flask\n"
        self.assertEqual({n for n, _ in self.names(a, cfg, self.P("setup.cfg"))},
                         {"requests", "flask"})
        py = ('from setuptools import setup\n'
              'setup(name="x", install_requires=["requests>=2.0", "flask"])\n'
              'install_requires = ["pytest"]\n')
        self.assertEqual({n for n, _ in self.names(a, py, self.P("setup.py"))},
                         {"requests", "flask", "pytest"})
        self.assertEqual(self.names(a, "print('not a setup')\n", self.P("setup.py")), [])

    def test_js_package_json_sections_and_scoped_names(self):
        a = dec.JavaScriptAdapter()
        text = json.dumps({
            "dependencies": {"@scope/pkg": "^1.0.0", "plain": "2.0.0"},
            "devDependencies": {"devdep": "1.0.0"},
            "peerDependencies": {"peerdep": "1.0.0"},
            "optionalDependencies": {"optdep": "1.0.0"},
        })
        names = {n for n, _ in self.names(a, text, self.P("package.json"))}
        self.assertEqual(names, {"@scope/pkg", "plain", "devdep", "peerdep", "optdep"})

    def test_go_mod(self):
        a = dec.GoAdapter()
        text = (
            "module github.com/me/proj\n\n"
            "go 1.21\n\n"
            "require (\n"
            "\tgithub.com/foo/bar v1.2.3\n"
            "\tgolang.org/x/mod v0.14.0 // indirect\n"
            "\tgithub.com/keep v0.1.0 // indirect\n"
            ")\n\n"
            "require github.com/single/one v2.0.0\n"
            "replace github.com/foo/bar => github.com/foo/bar v1.2.4\n"
            "exclude github.com/old v0.0.1\n"
        )
        names = {n for n, _ in self.names(a, text, self.P("go.mod"))}
        self.assertEqual(names, {"github.com/foo/bar", "github.com/single/one"})

    def test_rust_cargo_toml_and_lock(self):
        a = dec.RustAdapter()
        toml = (
            "[dependencies]\n"
            'serde = "1.0"\n'
            'tokio = { version = "1.35", features = ["full"] }\n'
            'gitdep = { git = "https://x/y.git" }\n'
            'local = { path = "../local" }\n'
            "workspaced = { workspace = true }\n"
            "[dev-dependencies]\n"
            'criterion = "0.5"\n'
            "[build-dependencies]\n"
            'cc = "1.0"\n'
        )
        names = {n for n, _ in self.names(a, toml, self.P("Cargo.toml"))}
        self.assertEqual(names, {"serde", "tokio", "workspaced", "criterion", "cc"})
        lock = (
            '[[package]]\nname = "serde"\nversion = "1.0.200"\n'
            'dependencies = [\n "serde_derive",\n]\n\n'
            '[[package]]\nname = "serde_derive"\nversion = "1.0.200"\n'
        )
        deps = self.names(a, lock, self.P("Cargo.lock"))
        by_name = dict(deps)
        self.assertEqual(by_name["serde"], "1.0.200")
        extracted = a.extract(lock, self.P("Cargo.lock"))
        by_name2 = {d.name: d for d in extracted}
        self.assertEqual(set(by_name2), {"serde", "serde_derive"})
        self.assertTrue(by_name2["serde_derive"].transitive)  # referenced by serde
        self.assertFalse(by_name2["serde"].transitive)  # root of the graph

    def test_java_pom_xml(self):
        a = dec.JavaAdapter()
        text = (
            '<project xmlns="http://maven.apache.org/POM/4.0.0">'
            "<dependencies>"
            "<dependency><groupId>com.example</groupId><artifactId>lib</artifactId>"
            "<version>1.2</version><scope>test</scope></dependency>"
            "<dependency><groupId>org.foo</groupId><artifactId>bar</artifactId></dependency>"
            "</dependencies></project>"
        )
        deps = dict(self.names(a, text, self.P("pom.xml")))
        self.assertEqual(deps, {"com.example:lib": "1.2", "org.foo:bar": None})

    def test_java_gradle(self):
        a = dec.JavaAdapter()
        text = (
            "dependencies {\n"
            "    implementation 'com.example:lib:1.2'\n"
            "    api group: 'org.foo', name: 'bar', version: '2.0'\n"
            "    compileOnly 'com.opt:opt:1.0'\n"
            "    implementation(\n"
            "        group: 'com.multi',\n"
            "        name: 'multi',\n"
            "        version: '3.0'\n"
            "    )\n"
            "    testImplementation 'junit:junit:4.13'\n"
            "}\n"
        )
        names = {n for n, _ in self.names(a, text, self.P("build.gradle"))}
        self.assertEqual(names, {"com.example:lib", "org.foo:bar", "com.opt:opt",
                                 "com.multi:multi", "junit:junit"})

    def test_dotnet_csproj_packages_config_and_central(self):
        a = dec.DotnetAdapter()
        csproj = (
            '<Project Sdk="Microsoft.NET.Sdk">'
            "<ItemGroup>"
            '<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />'
            '<PackageReference Include="NoVersion" />'
            '<ProjectReference Include="../Other/Other.csproj" />'
            "</ItemGroup></Project>"
        )
        names = {n for n, _ in self.names(a, csproj, self.P("App.csproj"))}
        self.assertEqual(names, {"Newtonsoft.Json", "NoVersion"})
        pc = '<packages><package id="log4net" version="2.0.8" /></packages>'
        self.assertEqual(dict(self.names(a, pc, self.P("packages.config"))), {"log4net": "2.0.8"})
        props = (
            "<Project><ItemGroup>"
            '<PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />'
            "</ItemGroup></Project>"
        )
        self.assertEqual(dict(self.names(a, props, self.P("Directory.Packages.props"))),
                         {"Newtonsoft.Json": "13.0.3"})

    def test_cpp_vcpkg_and_conan(self):
        a = dec.CppAdapter()
        vcpkg = json.dumps({
            "name": "app",
            "dependencies": ["zlib", {"name": "libpng", "host": True}],
            "host-dependencies": ["cmake"],
        })
        names = {n for n, _ in self.names(a, vcpkg, self.P("vcpkg.json"))}
        self.assertEqual(names, {"zlib", "libpng", "cmake"})
        txt = "[requires]\nopenssl/3.0.0\nboost/1.83.0@user/channel\n"
        self.assertEqual({n for n, _ in self.names(a, txt, self.P("conanfile.txt"))},
                         {"openssl", "boost"})
        py = 'class X(ConanFile):\n    requires = ("openssl/3.0.0", "zlib/1.3")\n'
        self.assertEqual({n for n, _ in self.names(a, py, self.P("conanfile.py"))},
                         {"openssl", "zlib"})
        lock = json.dumps({"graph_lock": {"nodes": {
            "0": {"ref": "app/1.0.0", "requires": ["openssl/3.0.0#r1"]},
        }}})
        self.assertEqual({n for n, _ in self.names(a, lock, self.P("conan.lock"))}, {"openssl"})

    def test_ruby_gemfile_lock_and_gemspec(self):
        a = dec.RubyAdapter()
        gemfile = (
            'source "https://rubygems.org"\n'
            'gem "rails", "~> 7.0"\n'
            "gem 'sinatra'\n"
            'gem "gitgem", git: "https://x/y.git"\n'
            'gem "pathgem", path: "../local"\n'
        )
        self.assertEqual({n for n, _ in self.names(a, gemfile, self.P("Gemfile"))},
                         {"rails", "sinatra"})
        lock = (
            "GIT\n  remote: https://x/y.git\n  revision: abc\n  specs:\n"
            "    gitgem (1.0.0)\n\n"
            "GEM\n  remote: https://rubygems.org/\n  specs:\n"
            "    activesupport (7.0.0)\n"
            "    rails (7.0.0)\n"
            "      activesupport (= 7.0.0)\n\n"
            "PLATFORMS\n  ruby\n\n"
            "DEPENDENCIES\n  rails (~> 7.0)\n"
        )
        deps = a.extract(lock, self.P("Gemfile.lock"))
        by_name = {d.name: d for d in deps}
        self.assertEqual(set(by_name), {"activesupport", "rails"})
        self.assertFalse(by_name["rails"].transitive)  # listed in DEPENDENCIES
        self.assertTrue(by_name["activesupport"].transitive)
        gemspec = ('Gem::Specification.new do |s|\n'
                   '  s.add_runtime_dependency "rack", ">= 2.0"\n'
                   '  s.add_development_dependency "rspec", "~> 3.0"\n'
                   '  s.add_dependency "json"\n'
                   'end\n')
        self.assertEqual({n for n, _ in self.names(a, gemspec, self.P("x.gemspec"))},
                         {"rack", "rspec", "json"})

    def test_php_composer(self):
        a = dec.PhpAdapter()
        composer = json.dumps({
            "require": {"vendor/pkg": "^2.0", "php": ">=8.0", "ext-json": "*", "lib-curl": "*"},
            "require-dev": {"vendor/dev": "^1.0"},
        })
        self.assertEqual({n for n, _ in self.names(a, composer, self.P("composer.json"))},
                         {"vendor/pkg", "vendor/dev"})
        lock = json.dumps({
            "packages": [{"name": "vendor/pkg", "version": "2.3.0"}],
            "packages-dev": [{"name": "vendor/dev", "version": "1.1.0"}],
        })
        self.assertEqual(dict(self.names(a, lock, self.P("composer.lock"))),
                         {"vendor/pkg": "2.3.0", "vendor/dev": "1.1.0"})

    def test_swift_package(self):
        a = dec.SwiftAdapter()
        text = (
            "// swift-tools-version:5.9\n"
            "import PackageDescription\n"
            'let package = Package(name: "x", dependencies: [\n'
            '    .package(url: "https://github.com/vapor/vapor.git", from: "4.0.0"),\n'
            '    .package(url: "https://github.com/pointfreeco/swift-composable-architecture", from: "1.0.0"),\n'
            '    .package(path: "../local"),\n'
            "])\n"
        )
        names = {n for n, _ in self.names(a, text, self.P("Package.swift"))}
        self.assertEqual(names, {"vapor/vapor", "pointfreeco/swift-composable-architecture"})

    def test_dart_pubspec(self):
        a = dec.DartAdapter()
        yaml = (
            "name: x\n"
            "environment:\n"
            "  sdk: '>=3.0.0'\n"
            "dependencies:\n"
            "  flutter:\n"
            "    sdk: flutter\n"
            "  http: ^1.0.0\n"
            "  gitdep:\n"
            "    git:\n"
            "      url: https://x/y.git\n"
            "  pathdep:\n"
            "    path: ../local\n"
            "dev_dependencies:\n"
            "  lints: ^3.0.0\n"
        )
        self.assertEqual({n for n, _ in self.names(a, yaml, self.P("pubspec.yaml"))},
                         {"http", "lints"})
        lock = (
            "packages:\n"
            "  http:\n"
            '    dependency: "direct main"\n'
            "    description:\n"
            "      name: http\n"
            "      sha256: abc\n"
            '    version: "1.1.0"\n'
            "  lints:\n"
            '    dependency: "direct dev"\n'
            '    version: "3.0.0"\n'
            "  matcher:\n"
            "    dependency: transitive\n"
            '    version: "0.0.1"\n'
        )
        deps = a.extract(lock, self.P("pubspec.lock"))
        by_name = {d.name: d for d in deps}
        self.assertEqual(by_name["http"].version, "1.1.0")
        self.assertFalse(by_name["http"].transitive)
        self.assertFalse(by_name["lints"].transitive)
        self.assertTrue(by_name["matcher"].transitive)


class RegistryAndTransportTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def test_registry_url_construction(self):
        fixtures = [
            ("pypi", {"requirements.txt": "requests\n"}, "requests"),
            ("npm", {"package.json": json.dumps({"dependencies": {"@scope/name": "1.0.0"}})},
             "@scope/name"),
            ("go", {"go.mod": "module m\n\nrequire github.com/Azure/foo v1.0.0\n"},
             "github.com/Azure/foo"),
            ("crates", {"Cargo.toml": '[dependencies]\nserde = "1"\n'}, "serde"),
            ("nuget", {"app.csproj": '<PackageReference Include="Newtonsoft.Json" />'},
             "Newtonsoft.Json"),
            ("vcpkg", {"vcpkg.json": json.dumps({"dependencies": ["zlib"]})}, "zlib"),
            ("conan", {"conanfile.txt": "[requires]\nopenssl/3.0.0\n"}, "openssl"),
            ("rubygems", {"Gemfile": 'gem "rails"\n'}, "rails"),
            ("packagist", {"composer.json": json.dumps({"require": {"vendor/pkg": "^1.0"}})},
             "vendor/pkg"),
            ("swift", {"Package.swift": '.package(url: "https://github.com/owner/repo.git", from: "1.0.0")\n'},
             "owner/repo"),
            ("pub", {"pubspec.yaml": "dependencies:\n  http: ^1.0.0\n"}, "http"),
        ]
        for reg, files, dep_name in fixtures:
            td, repo = write_repo(files)
            try:
                fetcher = FakeFetcher(routes=dict([ok_route(reg, dep_name)]))
                code, out = run_main(["--root", str(repo), "--json"], fetcher)
                r = json.loads(out)
                self.assertEqual(code, 0, f"{reg}: {r['failures']}")
                self.assertEqual(fetcher.requested_urls(),
                                 [url_for(reg, dep_name)], reg)
            finally:
                td.cleanup()

    def test_maven_two_requests(self):
        td, repo = write_repo({
            "pom.xml": ("<project><dependencies><dependency>"
                        "<groupId>com.example</groupId><artifactId>widget</artifactId>"
                        "</dependency></dependencies></project>"),
        })
        try:
            name = "com.example:widget"
            fetcher = FakeFetcher(routes=dict([
                ok_route("maven", name), ok_route("maven-version", name),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0, r["failures"])
            urls = fetcher.requested_urls()
            self.assertEqual(len(urls), 2)
            self.assertEqual(urls[0], url_for("maven", name))
            self.assertEqual(urls[1], url_for("maven-version", name))
            self.assertIsNotNone(r["checked"][0]["age_days"])
        finally:
            td.cleanup()

    def test_pypi_name_normalization(self):
        td, repo = write_repo({"requirements.txt": "Foo_Bar\n"})
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "foo-bar")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            self.assertEqual(code, 0)
            self.assertEqual(fetcher.requested_urls(),
                             ["https://pypi.org/pypi/foo-bar/json"])
        finally:
            td.cleanup()

    def test_404_is_not_found(self):
        td, repo = write_repo({"requirements.txt": "does-not-exist-xyz\n"})
        try:
            fetcher = FakeFetcher(routes=dict([
                not_found_route("pypi", "does-not-exist-xyz"),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            f = r["failures"][0]
            self.assertEqual(f["reason"], "not-found")
            self.assertEqual(f["source_file"], "requirements.txt")
            self.assertEqual(f["line"], 1)
        finally:
            td.cleanup()

    def test_5xx_retries_then_unreachable(self):
        td, repo = write_repo({"requirements.txt": "alpha\n"})
        try:
            url = url_for("pypi", "alpha")
            calls = {"n": 0}

            def flaky():
                calls["n"] += 1
                return 500, "", None

            fetcher = FakeFetcher(routes={url: (flaky, "", None)})
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            self.assertEqual(r["failures"][0]["reason"], "registry-unreachable")
            self.assertEqual(calls["n"], 3)  # 1 + 2 retries
        finally:
            td.cleanup()

    def test_network_error_recoverable_per_package(self):
        td, repo = write_repo({"requirements.txt": "alpha\nbeta\n"})
        try:

            def boom():
                raise ConnectionError("connection refused")

            fetcher = FakeFetcher(routes={
                url_for("pypi", "alpha"): (boom, "", None),
                url_for("pypi", "beta"): (200, pypi_body(), None),
            })
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)  # fail-closed on the unreachable package
            reasons = {f["reason"] for f in r["failures"]}
            self.assertEqual(reasons, {"registry-unreachable"})
            self.assertIn("unreachable", r["failures"][0]["message"])
            self.assertEqual(len(r["checked"]), 1)  # beta still checked
        finally:
            td.cleanup()

    def test_etag_cache_flow_and_persistence(self):
        with tempfile.TemporaryDirectory() as td:
            cache_dir = Path(td) / "cache"
            calls = []

            def opener(url, headers, etag):
                calls.append((url, etag))
                if etag == '"abc"':
                    return 304, {}, ""
                return 200, {"ETag": '"abc"'}, pypi_body()

            f1 = dec.RealFetcher(str(cache_dir), opener=opener)
            status, body, etag = f1.get("https://pypi.org/pypi/x/json")
            self.assertEqual(status, 200)
            self.assertEqual(etag, '"abc"')
            self.assertEqual(f1.stats.requests, 1)
            self.assertEqual(f1.stats.misses, 1)
            self.assertEqual(f1.stats.hits, 0)

            f2 = dec.RealFetcher(str(cache_dir), opener=opener)  # persisted cache
            status2, body2, _ = f2.get("https://pypi.org/pypi/x/json", etag='"abc"')
            self.assertEqual(status2, 200)
            self.assertIn("0.1.0", body2)  # cached body reused on 304
            self.assertEqual(f2.stats.hits, 1)
            self.assertEqual(f2.stats.requests, 0)  # 304 is not a registry hit
            self.assertEqual(len(calls), 2)

    def test_cache_dir_persists_across_two_runs(self):
        td, repo = write_repo({"requirements.txt": "alpha\n"})
        try:
            cache_dir = Path(td.name) / "cache"
            calls = []

            def opener(url, headers, etag):
                calls.append(url)
                if etag == '"e1"':
                    return 304, {}, ""
                return 200, {"ETag": '"e1"'}, pypi_body()

            f1 = dec.RealFetcher(str(cache_dir), opener=opener)
            code1, out1 = run_main(["--root", str(repo), "--json"], fetcher=f1)
            r1 = json.loads(out1)
            self.assertEqual(code1, 0)
            self.assertEqual(r1["cache"]["requests"], 1)
            self.assertEqual(r1["cache"]["hits"], 0)

            f2 = dec.RealFetcher(str(cache_dir), opener=opener)
            code2, out2 = run_main(["--root", str(repo), "--json"], fetcher=f2)
            r2 = json.loads(out2)
            self.assertEqual(code2, 0)
            self.assertEqual(r2["cache"]["requests"], 0)
            self.assertEqual(r2["cache"]["hits"], 1)
            self.assertEqual(len(r2["checked"]), 1)  # result still correct
        finally:
            td.cleanup()

    def test_user_agent_sent_on_every_request(self):
        td, repo = write_repo({
            "requirements.txt": "alpha\n",
            "Cargo.toml": '[dependencies]\nserde = "1"\n',
        })
        try:
            seen = []

            def opener(url, headers, etag):
                seen.append((url, headers.get("User-Agent")))
                if "crates.io" in url:
                    return 200, {}, json.dumps({"crate": {"created_at": OLD_ISO}})
                return 200, {}, pypi_body()

            fetcher = dec.RealFetcher(None, opener=opener)  # NoCache
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0, r["failures"])
            self.assertTrue(seen)
            for url, ua in seen:
                self.assertTrue(ua, f"User-Agent missing for {url}")
            crates = [url for url, _ in seen if "crates.io" in url]
            self.assertTrue(crates, "crates.io must be exercised")
        finally:
            td.cleanup()

    def test_rate_limiting_same_registry_spaced(self):
        old = dec.PypiRegistry.interval
        dec.PypiRegistry.interval = 0.05
        try:
            td, repo = write_repo({"requirements.txt": "alpha\nbeta\n"})
            try:
                fetcher = FakeFetcher(routes=dict([
                    ok_route("pypi", "alpha"), ok_route("pypi", "beta"),
                ]))
                start = time.monotonic()
                code, out = run_main(["--root", str(repo), "--json"], fetcher)
                elapsed = time.monotonic() - start
                self.assertEqual(code, 0)
                self.assertGreaterEqual(elapsed, 0.04)
            finally:
                td.cleanup()
        finally:
            dec.PypiRegistry.interval = old

    def test_rate_limiting_different_registries_not_cross_throttled(self):
        old = {n: dec.REGISTRIES[n].interval for n in ("pypi", "go")}
        dec.PypiRegistry.interval = 0.05
        dec.GoRegistry.interval = 0.05
        try:
            td, repo = write_repo({
                "requirements.txt": "alpha\n",
                "go.mod": "module m\n\nrequire github.com/foo/bar v1.0.0\n",
            })
            try:
                fetcher = FakeFetcher(routes=dict([
                    ok_route("pypi", "alpha"), ok_route("go", "github.com/foo/bar"),
                ]))
                start = time.monotonic()
                code, out = run_main(["--root", str(repo), "--json"], fetcher)
                elapsed = time.monotonic() - start
                self.assertEqual(code, 0)
                self.assertLess(elapsed, 0.04)  # one request per registry: no spacing
            finally:
                td.cleanup()
        finally:
            dec.PypiRegistry.interval = old["pypi"]
            dec.GoRegistry.interval = old["go"]

    def test_packagist_missing_vendor_no_crash(self):
        td, repo = write_repo({"composer.json": json.dumps({"require": {"nope": "^1.0"}})})
        try:
            fetcher = FakeFetcher()
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            self.assertEqual(r["failures"][0]["reason"], "registry-unreachable")
        finally:
            td.cleanup()

    def test_nuget_case_insensitive_id(self):
        td, repo = write_repo({
            "app.csproj": '<PackageReference Include="Newtonsoft.Json" />',
        })
        try:
            fetcher = FakeFetcher(routes=dict([
                ok_route("nuget", "newtonsoft.json"),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            self.assertEqual(code, 0)
            self.assertEqual(fetcher.requested_urls(),
                             ["https://api.nuget.org/v3/registration5-semver1/newtonsoft.json/index.json"])
        finally:
            td.cleanup()


class IgnoreMechanismTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def test_ignore_file_parsing(self):
        td, repo = write_repo({".slopsquat-ignore": (
            "# private company packages\n"
            "internal-common\n"
            "python:requests\n"
            "internal-*\n"
            "\n"
        )})
        try:
            f = dec.IgnoreFilter(repo)
            self.assertTrue(f.ignored("python", "internal-common"))
            self.assertTrue(f.ignored("go", "internal-common"))
            self.assertTrue(f.ignored("python", "requests"))
            self.assertFalse(f.ignored("go", "requests"))
            self.assertTrue(f.ignored("rust", "internal-auth-lib"))
        finally:
            td.cleanup()

    def test_ignored_package_zero_requests(self):
        td, repo = write_repo({
            ".slopsquat-ignore": "alpha\n",
            "requirements.txt": "alpha\nbeta\n",
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "beta")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            names = {c["name"] for c in r["checked"]}
            self.assertEqual(names, {"beta"})
            self.assertEqual(len(fetcher.requested_urls()), 1)
        finally:
            td.cleanup()

    def test_lang_scoping(self):
        td, repo = write_repo({
            ".slopsquat-ignore": "python:requests\n",
            "requirements.txt": "requests\n",
            "Cargo.toml": '[dependencies]\nrequests = "1"\n',
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("crates", "requests")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            names = {(c["language"], c["name"]) for c in r["checked"]}
            self.assertEqual(names, {("rust", "requests")})
            self.assertEqual(len(fetcher.requested_urls()), 1)
            self.assertIn("crates.io", fetcher.requested_urls()[0])
        finally:
            td.cleanup()

    def test_inline_markers(self):
        td, repo = write_repo({
            "requirements.txt": "ignored-py # slopsquat-ignore\nchecked-py\n",
            "go.mod": (
                "module m\n\n"
                "require (\n"
                "\tignored-go v1.0.0 // slopsquat-ignore\n"
                "\tchecked-go v1.0.0\n"
                ")\n"),
            "pom.xml": (
                "<project><dependencies>\n"
                "<dependency><groupId>com.x</groupId><artifactId>ignored-java</artifactId>"
                "</dependency><!-- slopsquat-ignore -->\n"
                "<dependency><groupId>com.x</groupId><artifactId>checked-java</artifactId>"
                "</dependency>\n"
                "</dependencies></project>"),
        })
        try:
            routes = dict([
                ok_route("pypi", "checked-py"),
                ok_route("go", "checked-go"),
                ok_route("maven", "com.x:checked-java"),
                ok_route("maven-version", "com.x:checked-java"),
            ])
            fetcher = FakeFetcher(routes=routes)
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0, r["failures"])
            names = {c["name"] for c in r["checked"]}
            self.assertEqual(names, {"checked-py", "checked-go", "com.x:checked-java"})
            for u in fetcher.requested_urls():
                self.assertNotIn("ignored", u)
        finally:
            td.cleanup()

    def test_json_formats_have_no_inline_markers(self):
        # A trailing comment inside package.json is invalid JSON; the file must
        # be skipped, not silently treated as an ignore marker.
        td, repo = write_repo({
            "package.json": '{\n  "dependencies": {\n    "alpha": "1.0.0" // slopsquat-ignore\n  }\n}\n',
        })
        try:
            fetcher = FakeFetcher()
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)  # malformed manifest skipped, no crash
            self.assertEqual(r["checked"], [])
        finally:
            td.cleanup()
        # JSON formats rely on .slopsquat-ignore instead:
        td, repo = write_repo({
            ".slopsquat-ignore": "alpha\n",
            "package.json": json.dumps({"dependencies": {"alpha": "1.0.0", "beta": "1.0.0"}}),
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("npm", "beta")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual({c["name"] for c in r["checked"]}, {"beta"})
        finally:
            td.cleanup()

    def test_ignore_file_only_at_root(self):
        td, repo = write_repo({
            "sub/.slopsquat-ignore": "alpha\n",
            "requirements.txt": "alpha\n",
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)  # alpha still checked (nested ignore not consulted)
            self.assertEqual(len(r["checked"]), 1)
        finally:
            td.cleanup()

    def test_inline_marker_dedupe_semantics(self):
        # Same name in two manifests, one marked -> still checked once.
        td, repo = write_repo({
            "requirements.txt": "alpha # slopsquat-ignore\n",
            "pyproject.toml": '[project]\ndependencies = ["alpha>=1"]\n',
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(len(r["checked"]), 1)
            self.assertEqual(len(fetcher.requested_urls()), 1)
        finally:
            td.cleanup()


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def test_e2e_real_worktree(self):
        repo = _HERE.parent  # the real worktree (package.json + go.mod + submanifests)
        fetcher = FakeFetcher(default=make_response)
        code, out = run_main(["--root", str(repo), "--json"], fetcher)
        r = json.loads(out)
        self.assertEqual(code, 0, r["failures"])
        self.assertTrue(r["checked"])
        urls = fetcher.requested_urls()
        # Cross-manifest dedupe: no URL requested twice.
        self.assertEqual(len(urls), len(set(urls)))
        # Only known registries were touched.
        for u in urls:
            self.assertTrue(any(h in u for h in (
                "registry.npmjs.org", "proxy.golang.org", "pypi.org", "rubygems.org",
            )), u)
        # Root package.json direct dep resolved from package-lock.json.
        lock = json.loads((repo / "package-lock.json").read_text())
        entry = next(c for c in r["checked"]
                     if c["language"] == "javascript" and c["name"] == "@octokit/graphql")
        expected = lock["packages"]["node_modules/@octokit/graphql"]["version"]
        self.assertEqual(entry["version"], expected)
        # Transitive-only names (not direct anywhere in the tree) are not requested.
        direct = set((lock["packages"][""].get("dependencies") or {}))
        direct |= set((lock["packages"][""].get("devDependencies") or {}))
        other_direct = set()
        for p in repo.rglob("package.json"):
            if "node_modules" in p.parts or ".git" in p.parts:
                continue
            if p.resolve() == (repo / "package.json").resolve():
                continue
            try:
                d = json.loads(p.read_text())
            except Exception:
                continue
            for sec in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
                other_direct.update((d.get(sec) or {}).keys())
        transitive_only = {
            k.split("node_modules/")[-1] for k in lock["packages"]
            if k.startswith("node_modules/") and k.split("node_modules/")[-1] not in direct
        }
        npm_requested = {urllib.parse.unquote(u.split("registry.npmjs.org/")[1])
                         for u in urls if "registry.npmjs.org/" in u}
        for n in transitive_only - other_direct:
            self.assertNotIn(n, npm_requested, f"transitive {n} was requested")

    def test_e2e_mixed_fixture_all_languages(self):
        fixtures = {
            "requirements.txt": "exists-py\nmissing-py\nyoung-py\n",
            "package.json": json.dumps({"dependencies": {
                "exists-js": "1.0.0", "missing-js": "1.0.0", "down-js": "1.0.0",
            }}),
            "go.mod": ("module example.com/m\n\ngo 1.21\n\nrequire (\n"
                       "\texists-go v1.0.0\n\tmissing-go v1.0.0\n)\n"),
            "Cargo.toml": '[dependencies]\nexists-rust = "1"\nmissing-rust = "1"\n',
            "pom.xml": (
                "<project><dependencies>"
                "<dependency><groupId>com.example</groupId><artifactId>exists-java</artifactId>"
                "<version>1.0</version></dependency>"
                "<dependency><groupId>com.example</groupId><artifactId>missing-java</artifactId>"
                "</dependency>"
                "</dependencies></project>"),
            "app.csproj": (
                "<Project><ItemGroup>"
                '<PackageReference Include="exists-dotnet" Version="1.0.0" />'
                '<PackageReference Include="missing-dotnet" />'
                "</ItemGroup></Project>"),
            "conanfile.txt": "[requires]\nexists-cpp/1.0.0\nmissing-cpp/1.0.0\n",
            "Gemfile": 'gem "exists-ruby"\ngem "missing-ruby"\n',
            "composer.json": json.dumps({"require": {
                "exists/vendor-php": "^1.0", "missing/vendor-php": "^1.0",
            }}),
            "Package.swift": (
                "// swift-tools-version:5.9\nimport PackageDescription\n"
                'let p = Package(name: "x", dependencies: [\n'
                '    .package(url: "https://github.com/owner/exists-swift.git", from: "1.0.0"),\n'
                '    .package(url: "https://github.com/owner/missing-swift.git", from: "1.0.0"),\n'
                "])\n"),
            "pubspec.yaml": (
                "name: x\ndependencies:\n  exists-dart: ^1.0.0\n  missing-dart: ^1.0.0\n"),
        }
        td, repo = write_repo(fixtures)
        try:
            routes = {}
            for n in ("exists-py", "exists-js", "exists-go", "exists-rust",
                      "exists-dotnet", "exists-ruby", "exists-dart"):
                reg = {"exists-py": "pypi", "exists-js": "npm", "exists-go": "go",
                       "exists-rust": "crates", "exists-dotnet": "nuget",
                       "exists-ruby": "rubygems", "exists-dart": "pub"}[n]
                routes.update([ok_route(reg, n)])
            routes.update([ok_route("conan", "exists-cpp")])
            routes.update([ok_route("packagist", "exists/vendor-php")])
            routes.update([ok_route("swift", "owner/exists-swift")])
            routes.update([ok_route("maven", "com.example:exists-java")])
            routes.update([ok_route("maven-version", "com.example:exists-java")])
            for n in ("missing-py", "missing-js", "missing-go", "missing-rust",
                      "missing-dotnet", "missing-ruby", "missing-dart"):
                reg = {"missing-py": "pypi", "missing-js": "npm", "missing-go": "go",
                       "missing-rust": "crates", "missing-dotnet": "nuget",
                       "missing-ruby": "rubygems", "missing-dart": "pub"}[n]
                routes.update([not_found_route(reg, n)])
            routes.update([not_found_route("conan", "missing-cpp")])
            routes.update([not_found_route("packagist", "missing/vendor-php")])
            routes.update([not_found_route("swift", "owner/missing-swift")])
            routes.update([not_found_route("maven", "com.example:missing-java")])
            routes.update([ok_route("pypi", "young-py", iso_days_ago(3))])

            def down():
                raise ConnectionError("registry down")

            routes[url_for("npm", "down-js")] = (down, "", None)

            fetcher = FakeFetcher(routes=routes)
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            self.assertFalse(r["ok"])
            by_reason = {}
            for f in r["failures"]:
                by_reason.setdefault(f["reason"], []).append(f)
                self.assertTrue(f["source_file"], f)
                self.assertIsInstance(f["line"], int)
            self.assertIn("not-found", by_reason)
            self.assertIn("too-young", by_reason)
            self.assertIn("registry-unreachable", by_reason)
            # every language's missing dep reported with its manifest
            not_found_files = {f["source_file"] for f in by_reason["not-found"]}
            for fn in ("requirements.txt", "package.json", "go.mod", "Cargo.toml",
                       "pom.xml", "app.csproj", "conanfile.txt", "Gemfile",
                       "composer.json", "Package.swift", "pubspec.yaml"):
                self.assertIn(fn, not_found_files)
            young = by_reason["too-young"][0]
            self.assertIn("days old", young["message"])
            self.assertIn("14-day", young["message"])
            self.assertIn("down-js", {f["name"] for f in by_reason["registry-unreachable"]})
            checked_names = {c["name"] for c in r["checked"]}
            self.assertIn("exists-py", checked_names)
            self.assertIn("owner/exists-swift", checked_names)
        finally:
            td.cleanup()

    def test_user_journey_a_hallucinated_dependency(self):
        td, repo = write_repo({
            "pyproject.toml": '[project]\ndependencies = ["surely-fake-package-zzz"]\n',
        })
        try:
            fetcher = FakeFetcher(routes=dict([
                not_found_route("pypi", "surely-fake-package-zzz"),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            f = r["failures"][0]
            self.assertEqual(f["reason"], "not-found")
            self.assertEqual(f["source_file"], "pyproject.toml")
            self.assertEqual(f["line"], 2)
        finally:
            td.cleanup()

    def test_user_journey_b_registered_but_young(self):
        td, repo = write_repo({"requirements.txt": "youngdep\n"})
        try:
            fetcher = FakeFetcher(routes=dict([
                ok_route("pypi", "youngdep", iso_days_ago(3)),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            f = r["failures"][0]
            self.assertEqual(f["reason"], "too-young")
            self.assertIn("3 days old", f["message"])
            self.assertIn("14-day safety threshold", f["message"])
        finally:
            td.cleanup()

    def test_user_journey_c_ignore_file_fixes_it(self):
        td, repo = write_repo({
            ".slopsquat-ignore": "youngdep\n",
            "requirements.txt": "youngdep\n",
        })
        try:
            fetcher = FakeFetcher()  # zero requests expected
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(r["checked"], [])
            self.assertEqual(fetcher.requested_urls(), [])
        finally:
            td.cleanup()

    def test_user_journey_d_registry_down_actionable(self):
        td, repo = write_repo({"requirements.txt": "alpha\n"})
        try:
            def down(u, etag):
                raise ConnectionError("registry down")

            fetcher = FakeFetcher(default=down)
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            self.assertEqual(r["failures"][0]["reason"], "registry-unreachable")
            self.assertIn("unreachable", r["failures"][0]["message"])
        finally:
            td.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
