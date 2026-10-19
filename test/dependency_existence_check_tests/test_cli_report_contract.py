"""CLI surface + JSON report contract.

Split out of test_pipeline_age_guard.py (issue #2034 God Object refactor): the
scenario module keeps the age-guard classification cases, this one keeps the
usage-error / report-shape cases. Both share `PipelineGuardBase` for the
registry-interval reset and the one-package probe.
"""

from ._common import *  # noqa: F401,F403
from ._bases import PipelineGuardBase


class CliReportContractTests(PipelineGuardBase):
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
