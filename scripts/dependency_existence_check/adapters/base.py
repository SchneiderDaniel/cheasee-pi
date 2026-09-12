"""Shared Adapter base and manifest-name helpers.

Lowest layer of the adapters package: imports only the domain models and
stdlib. Never imports an ecosystem module (one-directional dependency:
base <- ecosystem modules <- aggregation __init__).
"""

from __future__ import annotations

import fnmatch
import re
from pathlib import Path

from ..models import Dependency


def _pep508_name(spec: str) -> str | None:
    m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)", spec.strip())
    return m.group(1) if m else None


class Adapter:
    """Manifest grammar + registry binding. One class per language."""

    language = "base"
    patterns: tuple[str, ...] = ()
    priority = 10  # lockfiles / central manifests rank higher
    age_supported = True
    registry_name = "pypi"
    inline_marker: str | None = None  # trailing comment that ignores a dep line

    def detect(self, rel: Path, text: str) -> bool:
        return any(fnmatch.fnmatchcase(rel.name, p) for p in self.patterns)

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        return []

    def _dep(self, name: str, version: str | None, line: int = 0,
             transitive: bool = False, path: Path | None = None,
             priority: int | None = None, registry_name: str | None = None) -> Dependency:
        return Dependency(
            self.language, name, version, str(path) if path else "", line,
            transitive,
            self.priority if priority is None else priority,
            registry_name,
        )