"""Verify stage (`verify.check_selected`) and `Registry.check_dependency`.

Issue #2103 (Highly Coupled): registry lookup, age policy and the young-package
exemption live in `verify`, and the one per-ecosystem version rule moved behind
`Registry.check_dependency` — `core` no longer branches on the registry name.
"""

from ._common import *  # noqa: F401,F403
from ._bases import RegistryIntervalBase  # noqa: E402

_GO_LATEST = "https://proxy.golang.org/github.com/omega/lib/@latest"


class _Helper:
    """Builds a selection and calls the verify stage directly."""

    @staticmethod
    def _dep(name="alpha", version=None, language="python"):
        return dec.Dependency(language, name, version, "requirements.txt", 1)

    def _check(self, fetcher, deps, threshold=14, exempt=(), adapter=None):
        adapter = adapter if adapter is not None else dec.PythonAdapter()
        registries = {name: cls(fetcher) for name, cls in dec.REGISTRIES.items()}
        selected = [dec.verify.Selected(dep, adapter) for dep in deps]
        return dec.verify.check_selected(selected, registries, threshold, set(exempt))


class VerifyStageTests(_Helper, RegistryIntervalBase):
    def test_checked_record_shape_and_age(self):
        fetcher = FakeFetcher(routes=dict([
            ok_route("pypi", "alpha", iso_days_ago(30)),
        ]))
        checked, failures = self._check(fetcher, [self._dep()])
        self.assertEqual(failures, [])
        self.assertEqual(len(checked), 1)
        self.assertEqual(set(checked[0]), {"language", "name", "version",
                                           "age_days", "source_file", "line"})
        self.assertEqual(checked[0]["age_days"], 30)
        self.assertEqual(checked[0]["source_file"], "requirements.txt")

    def test_failure_reasons(self):
        unreachable_url, _ = ok_route("pypi", "alpha")
        malformed = json.dumps({"releases": {"0.1.0": [{"upload_time": "not-a-date"}]}})
        missing_url, _ = not_found_route("pypi", "alpha")
        too_young_url, _ = ok_route("pypi", "alpha", iso_days_ago(13))
        for label, routes, reason, fragments in [
            ("unreachable registry", {unreachable_url: (500, "", None)},
             "registry-unreachable", ["after 3 attempts"]),
            ("missing package", {missing_url: (404, "", None)},
             "not-found", ["does not exist in the pypi registry"]),
            ("too young", {too_young_url: (200, json.dumps(
                {"releases": {"0.1.0": [{"upload_time": iso_days_ago(13)}]}}), None)},
             "too-young", ["13 days old", "below 14-day safety threshold"]),
            ("unparseable date", {unreachable_url: (200, malformed, None)},
             "too-young", ["cannot verify age (fail-closed)"]),
        ]:
            with self.subTest(label):
                checked, failures = self._check(FakeFetcher(routes=routes), [self._dep()])
                self.assertEqual(checked, [])
                self.assertEqual(failures[0]["reason"], reason)
                for fragment in fragments:
                    self.assertIn(fragment, failures[0]["message"])

    def test_exemption_is_name_scoped(self):
        checked, failures = self._check(
            FakeFetcher(routes=dict([ok_route("pypi", "alpha", iso_days_ago(3))])),
            [self._dep("alpha", "1.0.0")], exempt={("alpha", "1.0.0")})
        self.assertEqual(failures, [])
        self.assertIsNone(checked[0]["age_days"])

        checked, failures = self._check(
            FakeFetcher(routes=dict([ok_route("pypi", "beta", iso_days_ago(3))])),
            [self._dep("beta", "1.0.0")], exempt={("alpha", "1.0.0")})
        self.assertEqual(checked, [])
        self.assertEqual(failures[0]["reason"], "too-young")

    def test_zero_threshold_disables_the_age_guard(self):
        checked, failures = self._check(
            FakeFetcher(routes=dict([ok_route("pypi", "alpha", iso_days_ago(0))])),
            [self._dep()], threshold=0)
        self.assertEqual(failures, [])
        self.assertEqual(checked[0]["age_days"], 0)

    def test_date_less_ecosystem_needs_no_release_date(self):
        dep = dec.Dependency("cpp", "zlib", None, "vcpkg.json", 3)
        checked, failures = self._check(
            FakeFetcher(routes=dict([ok_route("vcpkg", "zlib")])),
            [dep], adapter=dec.CppAdapter())
        self.assertEqual(failures, [])
        self.assertIsNone(checked[0]["age_days"])


class CheckDependencyTests(_Helper, RegistryIntervalBase):
    def test_default_delegates_to_check_without_a_version(self):
        class _Recording(dec.Registry):
            name = "recording"

            def check(self, name, *args, **kwargs):
                self.seen = getattr(self, "seen", []) + [(name, args, kwargs)]
                return dec.PackageRecord(True, OLD_ISO)

        registry = _Recording(FakeFetcher())
        dep = dec.Dependency("python", "alpha", "1.0.0", "requirements.txt", 1)
        self.assertTrue(registry.check_dependency(dep).exists)
        self.assertEqual(registry.seen, [("alpha", (), {})])

    def test_pypi_ignores_the_version_outside_go(self):
        fetcher = FakeFetcher(routes=dict([ok_route("pypi", "alpha")]))
        dec.PypiRegistry(fetcher).check_dependency(
            dec.Dependency("python", "alpha", "1.0.0", "requirements.txt", 1))
        self.assertEqual(fetcher.requested_urls(), [url_for("pypi", "alpha")])

    def test_go_passes_the_version_to_the_proxy(self):
        body = json.dumps({"Version": "v1.2.3", "Time": OLD_ISO})
        fetcher = FakeFetcher(routes={
            url_for("go", "github.com/omega/lib", "v1.2.3"): (200, body, None),
            _GO_LATEST: (200, body, None),
        })
        registry = dec.GoRegistry(fetcher)
        self.assertTrue(registry.check_dependency(dec.Dependency(
            "go", "github.com/omega/lib", "v1.2.3", "go.mod", 5)).exists)
        self.assertTrue(registry.check_dependency(dec.Dependency(
            "go", "github.com/omega/lib", None, "go.mod", 5)).exists)
        self.assertEqual(fetcher.requested_urls(), [
            url_for("go", "github.com/omega/lib", "v1.2.3"),
            _GO_LATEST,
        ])
