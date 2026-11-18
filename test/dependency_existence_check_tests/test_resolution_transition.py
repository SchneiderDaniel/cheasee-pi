"""Resolution is one explicit transition (issue #2096 CodeFlow `Dataclasses`).

`core._resolve_sources` owns the unresolved -> resolved step: it relativizes
`source_file` against the scan root and locates `line` in the manifest. It used
to write both fields back into the extraction-time `Dependency`; since #2096 the
records are frozen and the function returns `dataclasses.replace` copies.

These cases pin the happy path and the boundaries of that transition: the
returned record is a distinct object, the input keeps its absolute path and its
`0` line sentinel, and the structured-manifest `line` is never re-located.
Marker gating and the input-preservation cases live in
`test_resolution_markers.py`; the pipeline parity cases in
`test_resolution_pipeline.py` (one concern per module, all under the raw-text
function-count ceiling).
"""

from ._common import *  # noqa: F401,F403
from ._common import dec


def _python_adapters():
    return {"python": dec.PythonAdapter()}


class ResolutionTransitionTests(unittest.TestCase):
    """`_resolve_sources` returns copies; the extraction-time records stay intact."""

    def setUp(self):
        self._td, self._repo = write_repo({
            "requirements.txt": "alpha\nbeta\n",
            "empty.txt": "",
            "colon.txt": "<dependency><artifactId>artifact</artifactId></dependency>\n",
            "slash.txt": "require github.com/foo/bar v1.0.0\n",
        })
        self.repo = self._repo

    def tearDown(self):
        self._td.cleanup()

    def _resolve(self, deps):
        return dec.core._resolve_sources(deps, self.repo, _python_adapters())

    def test_returns_distinct_instances_and_leaves_inputs_untouched(self):
        abs_path = str(self.repo / "requirements.txt")
        original = dec.Dependency("python", "beta", source_file=abs_path)
        out = self._resolve([original])
        self.assertEqual(len(out), 1)
        self.assertIsNot(out[0], original)
        self.assertEqual(original.source_file, abs_path)
        self.assertEqual(original.line, 0)

    def test_absolute_source_file_becomes_root_relative(self):
        abs_path = str(self.repo / "requirements.txt")
        out = self._resolve([dec.Dependency("python", "beta", source_file=abs_path)])
        self.assertEqual(out[0].source_file, "requirements.txt")

    def test_unknown_line_is_located_one_based(self):
        abs_path = str(self.repo / "requirements.txt")
        out = self._resolve([dec.Dependency("python", "beta", source_file=abs_path)])
        self.assertEqual(out[0].line, 2)

    def test_colon_name_probes_suffix(self):
        abs_path = str(self.repo / "colon.txt")
        out = self._resolve([
            dec.Dependency("python", "com.x:artifact", source_file=abs_path)])
        self.assertEqual(out[0].line, 1)

    def test_slash_name_probes_last_segment(self):
        abs_path = str(self.repo / "slash.txt")
        out = self._resolve([
            dec.Dependency("python", "github.com/foo/bar", source_file=abs_path)])
        self.assertEqual(out[0].line, 1)

    def test_structured_line_is_preserved(self):
        abs_path = str(self.repo / "requirements.txt")
        out = self._resolve([dec.Dependency("python", "alpha", source_file=abs_path,
                                            line=2)])
        self.assertEqual(out[0].line, 2)

    def test_empty_source_file_stays_unresolved(self):
        out = self._resolve([dec.Dependency("python", "alpha")])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].source_file, "")
        self.assertEqual(out[0].line, 0)

    def test_missing_file_keeps_dep_with_unknown_line(self):
        abs_path = str(self.repo / "nope.txt")
        out = self._resolve([dec.Dependency("python", "alpha", source_file=abs_path)])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].source_file, "nope.txt")
        self.assertEqual(out[0].line, 0)

    def test_empty_file_keeps_dep_with_unknown_line(self):
        abs_path = str(self.repo / "empty.txt")
        out = self._resolve([dec.Dependency("python", "alpha", source_file=abs_path)])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].line, 0)
