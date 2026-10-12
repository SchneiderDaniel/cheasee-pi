"""Refactor invariants for the adapters package split (issue #1675).

Pure relocation: these tests pin the import graph, the public re-export
surface, the ADAPTERS snapshot, the per-module LOC budget, and end-to-end
pipeline parity against a pre-split baseline fixture.

Reuses the safety-net suite's importlib shim (registers sys.modules and
__path__) so the exact CLI/test import path is exercised, plus its
FakeFetcher/make_response so no network is touched.

Run: python3 test/dependency-existence-check-refactor.test.py

Regenerating the baseline fixture (test/fixtures/dependency-existence-worktree-baseline.json)
after intentional dependency-manifest changes:

    python3 -c "
import importlib.util, json, sys
from pathlib import Path
root = Path('.').resolve()
spec = importlib.util.spec_from_file_location('refactor_suite', root/'test/dependency-existence-check-refactor.test.py')
m = importlib.util.module_from_spec(spec); sys.modules['refactor_suite'] = m
spec.loader.exec_module(m)
for c in m.dec.REGISTRIES.values(): c.interval = 0
report = m.dec.run_check(m._ROOT, m.helper.FakeFetcher(default=m.helper.make_response), m.dec.SAFETY_THRESHOLD_DAYS, False, False)
got = [[c['language'], c['name'], c['version'], c['source_file'], c['line']] for c in report['checked']]
Path(m._BASELINE).write_text(json.dumps({'checked': got}, indent=2) + chr(10), encoding='utf-8')
"
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent.parent  # the test/ directory
_ROOT = _HERE.parent
_SCRIPTS = _ROOT / "scripts"
_PKG = _SCRIPTS / "dependency_existence_check"
_ADAPTERS_DIR = _PKG / "adapters"
_BASELINE = _HERE / "fixtures" / "dependency-existence-worktree-baseline.json"

# Load the existing suite as a helper module (it guards unittest.main), which
# loads the CLI shim exactly like production and exposes dec/FakeFetcher.
_spec = importlib.util.spec_from_file_location(
    "dec_existing_suite", _HERE / "dependency-existence-check.test.py")
assert _spec is not None
helper = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
sys.modules["dec_existing_suite"] = helper
_spec.loader.exec_module(helper)
dec = helper.dec

_PUBLIC_NAMES = {
    "ADAPTERS", "Adapter",
    "CppAdapter", "DartAdapter", "DotnetAdapter", "GoAdapter", "JavaAdapter",
    "JavaScriptAdapter", "PhpAdapter", "PythonAdapter", "RubyAdapter",
    "RustAdapter", "SwiftAdapter",
}
_SUBCLASSES = _PUBLIC_NAMES - {"ADAPTERS", "Adapter"}
_SUBMODULES = [
    "base", "python", "python_requirements", "python_metadata",
    "js", "go", "rust", "java", "dotnet", "cpp", "ruby", "php", "swift", "dart",
]
_ADAPTER_ATTRS = [
    ("python", 10, "pypi", True, "# slopsquat-ignore",
     ("requirements*.txt", "pyproject.toml", "Pipfile", "setup.py", "setup.cfg")),
    ("javascript", 10, "npm", True, None,
     ("package.json", "package-lock.json")),
    ("go", 10, "go", True, "// slopsquat-ignore",
     ("go.mod",)),
    ("rust", 10, "crates", True, "# slopsquat-ignore",
     ("Cargo.toml", "Cargo.lock")),
    ("java", 10, "maven", True, "<!-- slopsquat-ignore -->",
     ("pom.xml", "build.gradle", "build.gradle.kts")),
    ("dotnet", 10, "nuget", True, "<!-- slopsquat-ignore -->",
     ("*.csproj", "*.fsproj", "*.vbproj", "packages.config", "Directory.Packages.props")),
    ("cpp", 10, "vcpkg", False, "# slopsquat-ignore",
     ("vcpkg.json", "conanfile.txt", "conanfile.py", "conan.lock")),
    ("ruby", 10, "rubygems", True, "# slopsquat-ignore",
     ("Gemfile", "Gemfile.lock", "*.gemspec")),
    ("php", 10, "packagist", True, None,
     ("composer.json", "composer.lock")),
    ("swift", 10, "swift", False, "// slopsquat-ignore",
     ("Package.swift",)),
    ("dart", 10, "pub", True, "# slopsquat-ignore",
     ("pubspec.yaml", "pubspec.lock")),
]

__all__ = [
    "importlib",
    "json",
    "os",
    "subprocess",
    "sys",
    "tempfile",
    "unittest",
    "Path",
    "_HERE",
    "_ROOT",
    "_SCRIPTS",
    "_PKG",
    "_ADAPTERS_DIR",
    "_BASELINE",
    "_spec",
    "helper",
    "dec",
    "_PUBLIC_NAMES",
    "_SUBCLASSES",
    "_SUBMODULES",
    "_ADAPTER_ATTRS",
]
