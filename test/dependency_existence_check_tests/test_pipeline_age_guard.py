"""Pipeline + age-guard classification.

Split from test/dependency-existence-check.test.py (issue #2005 Long File refactor).
Split again by #2034: the shared lifecycle moved to `_bases.PipelineGuardBase`
and the CLI/report contract cases to `test_cli_report_contract.py`.
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401
from ._bases import PipelineGuardBase


class PipelineAndAgeGuardTests(PipelineGuardBase):
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

    def test_exempt_young_allows_specific_version_below_threshold(self):
        code, r = self._run_py_dep(iso_days_ago(3))
        self.assertEqual(code, 1)
        self.assertEqual(r["failures"][0]["reason"], "too-young")
        # Exempting the exact NAME@VERSION passes.
        code, r = self._run_py_dep(
            iso_days_ago(3),
            args_extra=["--exempt-young", "alpha@1.0.0"])
        self.assertEqual(code, 0, r["failures"])
        self.assertTrue(r["ok"])
        # Exemption is name-scoped (unpinned deps carry no version).
        code, r = self._run_py_dep(
            iso_days_ago(3),
            args_extra=["--exempt-young", "alpha@9.9.9"])
        self.assertEqual(code, 0, r["failures"])
        self.assertTrue(r["ok"])
        # Unrelated package stays blocked.
        code, r = self._run_py_dep(
            iso_days_ago(3),
            name="beta",
            args_extra=["--exempt-young", "alpha@1.0.0"])
        self.assertEqual(code, 1)
        self.assertEqual(r["failures"][0]["reason"], "too-young")

    def test_exempt_young_rejects_malformed_spec(self):
        code, out = run_main(["--exempt-young", "no-at-sign"], None)
        self.assertEqual(code, 2)

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
