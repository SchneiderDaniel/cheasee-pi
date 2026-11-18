"""Domain records are immutable value objects (issue #2096 CodeFlow `Dataclasses`).

The records in `models.py` were already `@dataclass`; the observation is that
`core._resolve_sources` mutated a `Dependency` in place after construction, which
hid the unresolved -> resolved transition (a reader of `source_file` before that
function silently saw `""`). Both records are now `frozen=True` and resolution
returns a `dataclasses.replace` copy, so this module pins the immutability half:
every field of both records, the positional construction contract the adapters
rely on, the sentinel defaults and value equality.

Scenario siblings, one concern each (split at the raw-text function-count
ceiling of 15, the same predicate behind `God Object`):

- `test_resolution_transition.py` — `_resolve_sources` returns copies: relativize
  and line location.
- `test_resolution_markers.py` — inline-marker gating, extraction sentinels and
  input preservation.
- `test_resolution_pipeline.py` — the copies survive dedupe -> verify -> report.
"""

import dataclasses

from ._common import *  # noqa: F401,F403
from ._common import dec

# The documented field order: `Adapter._dep` builds `Dependency` positionally, so
# this order is a contract and not an implementation detail.
_FIELDS = ["language", "name", "version", "source_file",
           "line", "transitive", "priority", "registry_name"]


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

    def test_adapter_dep_is_an_unresolved_frozen_record(self):
        # The extraction -> core handoff: adapters emit `source_file`/`line`
        # sentinels and the record they emit cannot be patched afterwards.
        dep = dec.PythonAdapter()._dep("alpha", "1.0.0",
                                       path=Path("requirements.txt"))
        self.assertEqual(dep.source_file, "requirements.txt")
        self.assertEqual(dep.line, 0)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            dep.line = 3  # type: ignore[misc]
