from ._common import *  # noqa: F401,F403


class CliSmokeTests(unittest.TestCase):
    def test_empty_root_json(self):
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run(
                [sys.executable, str(_SCRIPTS / "dependency-existence-check.py"),
                 "--root", d, "--json"],
                cwd=_ROOT, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            report = json.loads(r.stdout)
            self.assertEqual(set(report),
                             {"cache", "checked", "failures", "ok", "threshold_days"})
            self.assertTrue(report["ok"])
            self.assertEqual(report["checked"], [])
