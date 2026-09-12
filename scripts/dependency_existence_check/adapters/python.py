"""Python ecosystem adapter: filename/content detection + extract dispatch."""

from __future__ import annotations

import fnmatch
import tomllib
from pathlib import Path

from ..models import Dependency
from .base import Adapter
from .python_metadata import PipfileTomlMixin, SetupMixin
from .python_requirements import RequirementsMixin


class PythonAdapter(RequirementsMixin, PipfileTomlMixin, SetupMixin, Adapter):
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
            return self._requirements(text, path)
        if name in ("pyproject.toml", "Pipfile"):
            try:
                data = tomllib.loads(text)
            except tomllib.TOMLDecodeError:
                return []
            if name == "Pipfile":
                return self._pipfile(data, path)
            return self._toml(data, path)
        if name == "setup.cfg":
            return self._setup_cfg(text, path)
        if name == "setup.py":
            return self._setup_py(text, path)
        return []