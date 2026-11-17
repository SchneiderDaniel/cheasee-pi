"""Resolved copies survive the pipeline (issue #2096 CodeFlow `Dataclasses`).

`_resolve_sources` now returns `dataclasses.replace` copies instead of patched
records. Everything downstream — `_dedupe`, `verify`, report shaping — must see
the resolved location on those copies, and dedupe must still pick the same
winner. These cases go through the public `run_check` entry point so a copy that
loses its `source_file`/`line` (or an identity-based dedupe key) fails here
rather than in a report a user reads.

Relativize/locate and marker gating live in `test_resolution_transition.py` and
`test_resolution_markers.py`; record immutability in
`test_models_immutability.py`.
"""

from ._common import *  # noqa: F401,F403
from ._bases import PipelineGuardBase
from ._common import dec


def _python_adapters():
    return {"python": dec.PythonAdapter()}


class ResolutionPipelineParityTests(PipelineGuardBase):
    """Frozen copies must survive dedupe -> verify -> report shaping."""

    def setUp(self):
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        self._lock = str(Path(self._tmp.name) / "lock.txt")

    def tearDown(self):
        self._tmp.cleanup()
        super().tearDown()

    def test_checked_entry_carries_resolved_location(self):
        td, repo = write_repo({"requirements.txt": "alpha\n"})
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "alpha")]))
            report = dec.run_check(repo, fetcher, dec.SAFETY_THRESHOLD_DAYS,
                                   False, False)
        finally:
            td.cleanup()
        self.assertEqual(len(report["checked"]), 1)
        self.assertEqual(report["checked"][0]["source_file"], "requirements.txt")
        self.assertEqual(report["checked"][0]["line"], 1)

    def test_failure_entry_carries_resolved_location(self):
        td, repo = write_repo({"requirements.txt": "ghost\n"})
        try:
            fetcher = FakeFetcher(routes=dict([not_found_route("pypi", "ghost")]))
            report = dec.run_check(repo, fetcher, dec.SAFETY_THRESHOLD_DAYS,
                                   False, False)
        finally:
            td.cleanup()
        self.assertEqual(len(report["failures"]), 1)
        self.assertEqual(report["failures"][0]["reason"], "not-found")
        self.assertEqual(report["failures"][0]["source_file"], "requirements.txt")
        self.assertEqual(report["failures"][0]["line"], 1)

    def test_dedupe_prefers_direct_over_transitive_copies(self):
        resolved = dec.core._resolve_sources(
            [
                dec.Dependency("python", "alpha", transitive=True, priority=20,
                               source_file=self._lock),
                dec.Dependency("python", "alpha", transitive=False, priority=10,
                               source_file=self._lock),
            ],
            Path("/"), _python_adapters())
        winner = dec.core._dedupe(resolved, True)[("python", "alpha")]
        self.assertIs(winner.transitive, False)

    def test_dedupe_prefers_higher_priority_copy(self):
        originals = [
            dec.Dependency("python", "beta", transitive=True, priority=10,
                           source_file=self._lock),
            dec.Dependency("python", "beta", transitive=True, priority=20,
                           source_file=self._lock),
        ]
        resolved = dec.core._resolve_sources(originals, Path("/"),
                                            _python_adapters())
        winner = dec.core._dedupe(resolved, True)[("python", "beta")]
        self.assertEqual(winner.priority, 20)
        self.assertEqual(winner, resolved[1])
        self.assertIsNot(winner, originals[0])
        self.assertIsNot(winner, originals[1])
