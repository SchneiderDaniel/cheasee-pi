from ._common import *  # noqa: F401,F403


class BaselineParityTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def test_worktree_baseline_parity(self):
        # Snapshot parity: the baseline is the discovery output recorded in
        # test/fixtures/dependency-existence-worktree-baseline.json. Regenerate it
        # (with the snippet in the module docstring below) whenever the repo's
        # dependency manifests change intentionally, otherwise this test
        # reports a false regression.
        baseline = json.loads(_BASELINE.read_text(encoding="utf-8"))
        fetcher = helper.FakeFetcher(default=helper.make_response)
        report = dec.run_check(_ROOT, fetcher, dec.SAFETY_THRESHOLD_DAYS, False, False)
        got = [[c["language"], c["name"], c["version"], c["source_file"], c["line"]]
               for c in report["checked"]]
        self.assertEqual(got, baseline["checked"])
