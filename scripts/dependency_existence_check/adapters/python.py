"""Python ecosystem adapter: filename/content detection + extract dispatch.

The only Python class: it owns the dispatch, the TOML decode guard, and the
`Dependency` construction. The parsers in `python_requirements` /
`python_metadata` translate manifests into specs and know nothing about
`Adapter`.
"""

from __future__ import annotations

import fnmatch
import tomllib
from pathlib import Path

from ..models import Dependency
from .base import Adapter
from .python_metadata import parse_pipfile, parse_setup_cfg, parse_setup_py, parse_toml
from .python_requirements import parse_requirements
from .python_spec import ParsedSpec


class PythonAdapter(Adapter):
    language = "python"
    patterns = ("requirements*.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg")
    priority = 10
    registry_name = "pypi"
    inline_marker = "# slopsquat-ignore"

    def detect(self, rel: Path, text: str) -> bool:
        name = rel.name
        if fnmatch.fnmatchcase(name, "requirements*.txt") or name in ("pyproject.toml", "setup.cfg"):
            return True
        if name == "Pipfile":
            try:
                tomllib.loads(text)
                return True
            except tomllib.TOMLDecodeError:
                return False
        if name == "setup.py":
            return "install_requires" in text or "setup(" in text or "setuptools" in text
        return False

    def extract(self, text: str, path: Path | None = None) -> list[Dependency]:
        name = path.name if path else ""
        if fnmatch.fnmatchcase(name, "requirements*.txt"):
            return self._deps(parse_requirements(text, path))
        if name in ("pyproject.toml", "Pipfile"):
            try:
                data = tomllib.loads(text)
            except tomllib.TOMLDecodeError:
                return []
            if name == "Pipfile":
                return self._deps(parse_pipfile(data, path))
            return self._deps(parse_toml(data, path))
        if name == "setup.cfg":
            return self._deps(parse_setup_cfg(text, path))
        if name == "setup.py":
            return self._deps(parse_setup_py(text, path))
        return []

    def _deps(self, specs: list[ParsedSpec]) -> list[Dependency]:
        """Wrap parser output in domain records; adapter defaults apply."""
        return [self._dep(s.name, s.version, s.line, False, s.source) for s in specs]
