"""Python parse output: the spec record and the PEP 508 name helper.

The Python manifest parsers translate text or an already-parsed TOML mapping
into `ParsedSpec` records and carry no `Adapter` contract (no language,
priority or transitive field — every Python dependency uses the adapter
defaults). `PythonAdapter` is the only place that turns a spec into a domain
`Dependency`, which is why this module imports neither `Adapter` nor `Dependency`.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import NamedTuple


class ParsedSpec(NamedTuple):
    """One manifest entry: `(name, version, line, source)`.

    `line` is 1-based within `source`; 0 means "unknown", which is what the
    structured formats (TOML, Pipfile, setup.py) report. `source` is the file
    the entry was read from — the include file for a `-r` entry, not its parent.
    """

    name: str
    version: str | None
    line: int
    source: Path | None


def pep508_name(spec: str) -> str | None:
    """Leading project name of a PEP 508 requirement string."""
    m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)", spec.strip())
    return m.group(1) if m else None
