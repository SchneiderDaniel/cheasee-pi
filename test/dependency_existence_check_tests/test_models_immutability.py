"""Domain records are immutable value objects (issue #2096 CodeFlow `Dataclasses`).

The records in `models.py` are already `@dataclass`; the observation is that
`core._resolve_sources` mutated a `Dependency` in place after construction, which
hid the unresolved->resolved transition (a reader of `source_file` before that
function silently saw `""`). Freezing both records and resolving through
`dataclasses.replace` makes the transition explicit and gives the copy rather
than the extraction-time record.

Three concerns, three classes: record immutability (the decorator), the
resolution transition (the rewrite), and pipeline parity through `run_check`
(the copies must survive dedupe/verify/report shaping).
"""

import dataclasses
from unittest import mock

from ._common import *  # noqa: F401,F403
from ._bases import PipelineGuardBase
from ._common import dec

_FIELDS = ["language", "name", "version", "source_file",
           "line", "transitive", "priority", "registry_name"]


def _python_adapters():
    return {"python": dec.PythonAdapter()}


class RecordImmutabilityTests(unittest.TestCase):
    def test_dependency_field_assignment_raises(self):
        dep = dec.Dependency(language="python", name="alpha")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            dep.name = "beta"  # type: ignore[misc]

    def test_every_dependency_field_is_frozen(self):
        dep = dec.Dependency(language="python", name="alpha")
        revised = dec.Dependency(
            language="go", name="beta", version="2.0.0", source_file="/x",
            line=4, transitive=True, priority=30, registry_name="crates")
        for field in dataclasses.fields(dec.Dependency):
            self.assertIn(field.name, _FIELDS)
            with self.assertRaises(dataclasses.FrozenInstanceError):
                setattr(dep, field.name, getattr(revised, field.name))

    def test_package_record_is_frozen(self):
        rec = dec.PackageRecord(exists=True)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            rec.exists = False  # type: ignore[misc]
        with self.assertRaises(dataclasses.FrozenInstanceError):
            rec.earliest_release_iso = "2020-01-01T00:00:00+00:00"  # type: ignore[misc]

    def test_dependency_positional_construction_contract(self):
        # `Adapter._dep` builds Dependency positionally with 8 fields: field
        # order is a contract, not an implementation detail.
        dep = dec.Dependency("python", "alpha", "1.0.0", "/abs/requirements.txt",
                             7, True, 20, "pypi")
        self.assertEqual(
            (dep.language, dep.name, dep.version, dep.source_file, dep.line,
             dep.transitive, dep.priority, dep.registry_name),
            ("python", "alpha", "1.0.0", "/abs/requirements.txt", 7, True, 20,
             "pypi"),
        )

    def test_defaults_unchanged(self):
        dep = dec.Dependency("python", "alpha")
        self.assertIsNone(dep.version)
        self.assertEqual(dep.source_file, "")
        self.assertEqual(dep.line, 0)
        self.assertIs(dep.transitive, False)
        self.assertEqual(dep.priority, 10)
        self.assertIsNone(dep.registry_name)
        self.assertIsNone(dec.PackageRecord(False).earliest_release_iso)

    def test_value_equality_preserved(self):
        a = dec.Dependency("python", "alpha", source_file="requirements.txt", line=1)
        b = dec.Dependency("python", "alpha", source_file="requirements.txt", line=1)
        c = dec.Dependency("python", "alpha", source_file="requirements.txt", line=2)
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_field_order_snapshot(self):
        self.assertEqual([f.name for f in dataclasses.fields(dec.Dependency)],
                         _FIELDS)


class ResolutionTransitionTests(unittest.TestCase):
    """`_resolve_sources` returns copies; the extraction-time records stay intact."""

    def setUp(self):
        self._td, self._repo = write_repo({
            "requirements.txt": "alpha\nbeta\n",
            "empty.txt": "",
            "colon.txt": "<dependency><artifactId>artifact</artifactId></dependency>\n",
            "slash.txt": "require github.com/foo/bar v1.0.0\n",
            "marked.txt": "alpha # slopsquat-ignore\nzeta\n",
            "lastline.txt": "one\ntwo\nlast-dep # slopsquat-ignore\n",
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

    def test_adapter_dep_is_an_unresolved_frozen_record(self):
        dep = dec.PythonAdapter()._dep("alpha", "1.0.0",
                                       path=Path("requirements.txt"))
        self.assertEqual(dep.source_file, "requirements.txt")
        self.assertEqual(dep.line, 0)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            dep.line = 3  # type: ignore[misc]
