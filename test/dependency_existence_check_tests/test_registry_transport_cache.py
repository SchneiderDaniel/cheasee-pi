"""Registry clients and the fetch/cache transport — retry/network/cache/rate-limit family.

Split from test/dependency-existence-check.test.py (issue #2005 Long File
refactor) and re-split by scenario (issue #2006 VBA God Module refactor); the
shared harness lives in `_bases.py`.
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401
from ._bases import RegistryIntervalBase  # noqa: E402

class RegistryTransportCacheTests(RegistryIntervalBase):
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
