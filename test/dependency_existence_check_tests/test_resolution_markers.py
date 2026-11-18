"""Inline markers and input preservation during resolution (issue #2096).

`core._resolve_sources` drops a dependency whose resolved line carries the
registry's `# slopsquat-ignore` marker, keeps it when the line cannot be
resolved, and hands back copies so a caller's list and records are untouched.
These cases pin that gating and the copy semantics: the marker check only runs
on a resolved line, the last-line boundary is inclusive, a `relpath` failure
keeps the absolute path (the Windows drive-mismatch branch), and the returned
order equals the input order minus the dropped records.

Relativize/locate and the sentinel boundaries live in
`test_resolution_transition.py`; pipeline parity in
`test_resolution_pipeline.py`.
"""

from unittest import mock

from ._common import *  # noqa: F401,F403
from ._common import dec


def _python_adapters():
    return {"python": dec.PythonAdapter()}


class ResolutionMarkerTests(unittest.TestCase):
    """Marker gating and input preservation across one resolution pass."""

    def setUp(self):
        self._td, self._repo = write_repo({
            "requirements.txt": "alpha\nbeta\n",
            "marked.txt": "alpha # slopsquat-ignore\nzeta\n",
            "lastline.txt": "one\ntwo\nlast-dep # slopsquat-ignore\n",
        })
        self.repo = self._repo

    def tearDown(self):
        self._td.cleanup()

    def _resolve(self, deps):
        return dec.core._resolve_sources(deps, self.repo, _python_adapters())

    def test_inline_marker_drops_the_dep(self):
        abs_path = str(self.repo / "marked.txt")
        out = self._resolve([dec.Dependency("python", "alpha", source_file=abs_path)])
        self.assertEqual(out, [])

    def test_marker_check_is_gated_on_resolved_line(self):
        # `zeta` is on the unmarked line 2; the marker on line 1 must not drop it.
        abs_path = str(self.repo / "marked.txt")
        out = self._resolve([dec.Dependency("python", "zeta", source_file=abs_path)])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].line, 2)

    def test_unresolvable_line_skips_marker_check(self):
        abs_path = str(self.repo / "marked.txt")
        out = self._resolve([dec.Dependency("python", "absent", source_file=abs_path)])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].line, 0)

    def test_marker_on_last_line_boundary(self):
        abs_path = str(self.repo / "lastline.txt")
        out = self._resolve([
            dec.Dependency("python", "last-dep", source_file=abs_path)])
        self.assertEqual(out, [])

    def test_relpath_valueerror_keeps_the_absolute_path(self):
        abs_path = str(self.repo / "requirements.txt")
        with mock.patch("dependency_existence_check.core.os.path.relpath",
                        side_effect=ValueError("drive mismatch")):
            out = self._resolve([dec.Dependency("python", "beta",
                                                source_file=abs_path)])
        self.assertEqual(out[0].source_file, abs_path)

    def test_inputs_unchanged_after_multi_dep_resolve(self):
        abs_path = str(self.repo / "requirements.txt")
        deps = [
            dec.Dependency("python", "alpha", source_file=abs_path),
            dec.Dependency("python", "beta", source_file=abs_path, line=5),
        ]
        out = self._resolve(deps)
        self.assertEqual(len(out), 2)
        for dep in deps:
            self.assertEqual(dep.source_file, abs_path)
        self.assertEqual(deps[0].line, 0)
        self.assertEqual(deps[1].line, 5)

    def test_returned_order_matches_input_order(self):
        abs_path = str(self.repo / "requirements.txt")
        marked = str(self.repo / "marked.txt")
        out = self._resolve([
            dec.Dependency("python", "beta", source_file=abs_path),
            dec.Dependency("python", "alpha", source_file=marked),  # dropped
            dec.Dependency("python", "alpha", source_file=abs_path),
        ])
        self.assertEqual([d.name for d in out], ["beta", "alpha"])
        self.assertEqual([d.line for d in out], [2, 1])
