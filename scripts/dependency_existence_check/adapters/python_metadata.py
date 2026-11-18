"""Python manifest parsing: Pipfile TOML, pyproject.toml, setup.cfg, setup.py.

Pure translation — text or an already-parsed mapping in, specs out. `tomllib`
stays in `PythonAdapter.extract` so the TOML decode guard lives with the
dispatch, and `PythonAdapter` is the only place a `Dependency` is built.
"""

from __future__ import annotations

import ast
from pathlib import Path

from .python_spec import ParsedSpec, pep508_name


def parse_pipfile(data: dict, path: Path | None = None) -> list[ParsedSpec]:
    """Specs from a parsed Pipfile: `[packages]` and `[dev-packages]`."""
    specs: list[ParsedSpec] = []
    for table in ("packages", "dev-packages"):
        for name, spec in (data.get(table) or {}).items():
            if isinstance(spec, dict):
                if any(k in spec for k in ("git", "path", "file", "editable")):
                    continue  # VCS/local entries are not registry packages
                version = spec.get("version")
            elif isinstance(spec, str):
                version = spec
            else:
                version = None
            specs.append(ParsedSpec(name, version, 0, path))
    return specs


def parse_toml(data: dict, path: Path | None = None) -> list[ParsedSpec]:
    """Specs from a parsed pyproject.toml: PEP 621 tables plus poetry."""
    specs: list[ParsedSpec] = []
    project = data.get("project") or {}
    groups = [project.get("dependencies") or []]
    groups += list((project.get("optional-dependencies") or {}).values())
    for group in groups:
        for spec in group or []:
            name = pep508_name(spec) if isinstance(spec, str) else None
            if name:
                specs.append(ParsedSpec(name, None, 0, path))
    poetry = (data.get("tool") or {}).get("poetry") or {}
    for table in (poetry.get("dependencies") or {}, poetry.get("dev-dependencies") or {}):
        for name, spec in (table or {}).items():
            if name == "python":
                continue
            if isinstance(spec, dict) and any(k in spec for k in ("git", "path", "url")):
                continue
            specs.append(ParsedSpec(name, None, 0, path))
    return specs


def parse_setup_cfg(text: str, path: Path | None = None) -> list[ParsedSpec]:
    """Specs from the `install_requires` block of a setup.cfg `[options]`."""
    specs: list[ParsedSpec] = []
    section = ""
    in_requires = False
    for line_no, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped[1:-1].strip()
            in_requires = False
            continue
        if section != "options":
            continue
        if stripped.startswith("install_requires"):
            in_requires = True
            rest = stripped.split("=", 1)[1].strip() if "=" in stripped else ""
            candidates = [rest] if rest else []
        elif in_requires:
            if not stripped or stripped.startswith(("#", ";")):
                continue
            if not line.startswith((" ", "\t")):
                in_requires = False  # dedented: the block ended
                continue
            candidates = [stripped]
        else:
            continue
        for spec in candidates:
            name = pep508_name(spec)
            if name:
                specs.append(ParsedSpec(name, None, line_no, path))
    return specs


def _literal_names(value: ast.AST) -> list[str]:
    """Names of the string literals in an `install_requires` list or tuple."""
    if not isinstance(value, (ast.List, ast.Tuple)):
        return []  # non-literal (e.g. a variable) is not resolvable here
    literals = (element.value for element in value.elts
                if isinstance(element, ast.Constant) and isinstance(element.value, str))
    return [name for name in map(pep508_name, literals) if name]


def parse_setup_py(text: str, path: Path | None = None) -> list[ParsedSpec]:
    """Specs from literal `install_requires` values in a setup.py."""
    specs: list[ParsedSpec] = []
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == "setup"):
            values = [kw.value for kw in node.keywords if kw.arg == "install_requires"]
        elif isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "install_requires"
                for t in node.targets):
            values = [node.value]
        else:
            continue
        for value in values:
            specs.extend(ParsedSpec(n, None, 0, path) for n in _literal_names(value))
    return specs
