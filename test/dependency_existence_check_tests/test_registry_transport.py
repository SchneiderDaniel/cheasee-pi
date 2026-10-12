"""Registry clients and the fetch/cache transport.

Split from test/dependency-existence-check.test.py (issue #2005 Long File refactor).
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401

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
                if _netloc(url) == "crates.io":
                    return 200, {}, json.dumps({"crate": {"created_at": OLD_ISO}})
                return 200, {}, pypi_body()

            fetcher = dec.RealFetcher(None, opener=opener)  # NoCache
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0, r["failures"])
            self.assertTrue(seen)
            for url, ua in seen:
                self.assertTrue(ua, f"User-Agent missing for {url}")
            crates = [url for url, _ in seen if _netloc(url) == "crates.io"]
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


