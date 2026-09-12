#!/usr/bin/env python3
"""Refactor invariants for the adapters package split (issue #1675).

Pure relocation: these tests pin the import graph, the public re-export
surface, the ADAPTERS snapshot, the per-module LOC budget, and end-to-end
pipeline parity against a pre-split baseline fixture.

Reuses the safety-net suite's importlib shim (registers sys.modules and
__path__) so the exact CLI/test import path is exercised, plus its
FakeFetcher/make_response so no network is touched.

Run: python3 test/dependency-existence-check-refactor.test.py
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
_SCRIPTS = _ROOT / "scripts"
_PKG = _SCRIPTS / "dependency_existence_check"
_ADAPTERS_DIR = _PKG / "adapters"
_BASELINE = _HERE / "fixtures" / "dependency-existence-worktree-baseline.json"

# Load the existing suite as a helper module (it guards unittest.main), which
# loads the CLI shim exactly like production and exposes dec/FakeFetcher.
_spec = importlib.util.spec_from_file_location(
    "dec_existing_suite", _HERE / "dependency-existence-check.test.py")
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


class PackageSplitTests(unittest.TestCase):
    def test_adapters_resolves_to_package(self):
        self.assertTrue(hasattr(dec.adapters, "__path__"))
        self.assertTrue(str(dec.adapters.__file__).endswith(
            os.path.join("adapters", "__init__.py")))
        # A leftover single-file module would be silently shadowed; fail closed.
        self.assertFalse((_PKG / "adapters.py").exists())

    def test_fresh_interpreter_imports(self):
        env = dict(os.environ, PYTHONPATH=str(_SCRIPTS))
        base = subprocess.run(
            [sys.executable, "-c",
             "from dependency_existence_check.adapters import base"],
            cwd=_ROOT, env=env, capture_output=True, text=True)
        self.assertEqual(base.returncode, 0, base.stderr)
        code = (
            "import importlib\n"
            "for m in {mods!r}:\n"
            "    importlib.import_module('dependency_existence_check.adapters.' + m)\n"
            "import dependency_existence_check\n"
            "import dependency_existence_check.core\n"
            "import dependency_existence_check.cli\n"
        ).format(mods=_SUBMODULES)
        r = subprocess.run([sys.executable, "-c", code],
                           cwd=_ROOT, env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_module_loc_budget(self):
        for p in sorted(_ADAPTERS_DIR.glob("*.py")):
            loc = len(p.read_text(encoding="utf-8").splitlines())
            self.assertLessEqual(loc, 120, f"{p.name} is {loc} LOC")

    def test_base_imports_no_ecosystem_module(self):
        src = (_ADAPTERS_DIR / "base.py").read_text(encoding="utf-8")
        for mod in ("python", "js", "go", "rust", "java", "dotnet",
                    "cpp", "ruby", "php", "swift", "dart"):
            self.assertNotIn(f"from .{mod} import", src)
        self.assertNotIn("adapters import ADAPTERS", src)


class PublicSurfaceTests(unittest.TestCase):
    def test_reexport_set(self):
        for name in _PUBLIC_NAMES:
            self.assertTrue(hasattr(dec, name), f"shim missing {name}")
            self.assertTrue(hasattr(dec.adapters, name), f"package missing {name}")

    def test_all_declared(self):
        self.assertEqual(set(dec.adapters.__all__), _PUBLIC_NAMES)

    def test_core_adapters_identity(self):
        self.assertIs(dec.core.ADAPTERS, dec.ADAPTERS)

    def test_adapters_snapshot(self):
        got = [(a.language, a.priority, a.registry_name, a.age_supported,
                a.inline_marker, a.patterns) for a in dec.ADAPTERS]
        self.assertEqual(got, _ADAPTER_ATTRS)

    def test_adapter_classes(self):
        for a in dec.ADAPTERS:
            self.assertIsInstance(a, dec.Adapter)
            self.assertIn(type(a).__name__, _SUBCLASSES)
        for name in _SUBCLASSES:
            self.assertTrue(issubclass(getattr(dec, name), dec.Adapter), name)
        self.assertNotIn(type(dec.Adapter()), [type(a) for a in dec.ADAPTERS])


class BaselineParityTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def test_worktree_baseline_parity(self):
        baseline = json.loads(_BASELINE.read_text(encoding="utf-8"))
        fetcher = helper.FakeFetcher(default=helper.make_response)
        report = dec.run_check(_ROOT, fetcher, dec.SAFETY_THRESHOLD_DAYS, False, False)
        got = [[c["language"], c["name"], c["version"], c["source_file"], c["line"]]
               for c in report["checked"]]
        self.assertEqual(got, baseline["checked"])


class CliSmokeTests(unittest.TestCase):
    def test_empty_root_json(self):
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run(
                [sys.executable, str(_SCRIPTS / "dependency-existence-check.py"),
                 "--root", d, "--json"],
                cwd=_ROOT, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            report = json.loads(r.stdout)
            self.assertEqual(set(report),
                             {"cache", "checked", "failures", "ok", "threshold_days"})
            self.assertTrue(report["ok"])
            self.assertEqual(report["checked"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
