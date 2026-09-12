"""Python manifest extraction: Pipfile TOML, pyproject.toml, setup.cfg, setup.py."""

from __future__ import annotations

import ast
import tomllib
from pathlib import Path

from ..models import Dependency
from .base import _pep508_name


class PipfileTomlMixin:
    def _pipfile(self, data: dict, path: Path | None) -> list[Dependency]:
        deps = []
        for table in ("packages", "dev-packages"):
            for n, spec in (data.get(table) or {}).items():
                if isinstance(spec, dict):
                    if any(k in spec for k in ("git", "path", "file", "editable")):
                        continue  # VCS/local entries are not registry packages
                    version = spec.get("version")
                elif isinstance(spec, str):
                    version = spec
                else:
                    version = None
                deps.append(self._dep(n, version, 0, False, path))
        return deps

    def _toml(self, data: dict, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        project = data.get("project") or {}
        for spec in project.get("dependencies") or []:
            if isinstance(spec, str):
                n = _pep508_name(spec)
                if n:
                    deps.append(self._dep(n, None, 0, False, path))
        for group in (project.get("optional-dependencies") or {}).values():
            for spec in group or []:
                if isinstance(spec, str):
                    n = _pep508_name(spec)
                    if n:
                        deps.append(self._dep(n, None, 0, False, path))
        poetry = (data.get("tool") or {}).get("poetry") or {}
        for table in (poetry.get("dependencies") or {}, poetry.get("dev-dependencies") or {}):
            for n, spec in (table or {}).items():
                if n == "python":
                    continue
                if isinstance(spec, dict) and any(k in spec for k in ("git", "path", "url")):
                    continue
                deps.append(self._dep(n, None, 0, False, path))
        return deps


class SetupMixin:
    def _setup_cfg(self, text: str, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        section = ""
        in_ir = False
        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if s.startswith("[") and s.endswith("]"):
                section = s[1:-1].strip()
                in_ir = False
                continue
            if section != "options":
                continue
            if s.startswith("install_requires"):
                in_ir = True
                rest = s.split("=", 1)[1].strip() if "=" in s else ""
                candidates = [rest] if rest else []
            elif in_ir:
                if not s or s.startswith(("#", ";")):
                    continue
                if not line.startswith((" ", "\t")):
                    in_ir = False
                    continue
                candidates = [s]
            else:
                continue
            for spec in candidates:
                n = _pep508_name(spec)
                if n:
                    deps.append(self._dep(n, None, i, False, path))
        return deps

    def _setup_py(self, text: str, path: Path | None) -> list[Dependency]:
        deps: list[Dependency] = []
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "setup":
                for kw in node.keywords:
                    if kw.arg == "install_requires" and isinstance(kw.value, (ast.List, ast.Tuple)):
                        for elt in kw.value.elts:
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                n = _pep508_name(elt.value)
                                if n:
                                    deps.append(self._dep(n, None, 0, False, path))
            elif isinstance(node, ast.Assign) and isinstance(node.value, (ast.List, ast.Tuple)):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == "install_requires":
                        for elt in node.value.elts:
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                n = _pep508_name(elt.value)
                                if n:
                                    deps.append(self._dep(n, None, 0, False, path))
        return deps