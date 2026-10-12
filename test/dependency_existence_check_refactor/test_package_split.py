from ._common import *  # noqa: F401,F403


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
