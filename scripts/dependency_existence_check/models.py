"""Domain records and invariants shared across the dependency-existence check.

Both records are frozen value objects. Extraction emits a `Dependency`
unresolved (`source_file=""`, `line=0`) and `core._resolve_sources` returns a
resolved copy via `dataclasses.replace`, so no record is mutated after
construction and the unresolved -> resolved step stays visible in one place.

No framework imports; this is the lowest layer of the split package.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Dependency:
    language: str
    name: str
    version: str | None = None
    source_file: str = ""  # absolute at extraction time; relativized by core
    line: int = 0  # 0 = unknown (structured formats); resolved by core
    transitive: bool = False
    priority: int = 10
    registry_name: str | None = None  # overrides the adapter default (C/C++)


@dataclass(frozen=True)
class PackageRecord:
    exists: bool
    earliest_release_iso: str | None = None


class RegistryError(Exception):
    """Registry unreachable, malformed response, or unusable data."""
