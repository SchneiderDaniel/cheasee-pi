"""Domain records and invariants shared across the dependency-existence check.

No framework imports; this is the lowest layer of the split package.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Dependency:
    language: str
    name: str
    version: str | None = None
    source_file: str = ""  # absolute at extraction time; relativized by core
    line: int = 0  # 0 = unknown (structured formats); resolved by core
    transitive: bool = False
    priority: int = 10
    registry_name: str | None = None  # overrides the adapter default (C/C++)


@dataclass
class PackageRecord:
    exists: bool
    earliest_release_iso: str | None = None


class RegistryError(Exception):
    """Registry unreachable, malformed response, or unusable data."""
