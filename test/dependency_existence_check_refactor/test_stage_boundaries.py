"""Stage boundaries after the issue #2103 split.

Assertions read source text / AST only: no network, no temp repos. They pin the
core as a thin sequencer, the two new stages as CLI/transport-free, and the
"no sibling private imports" rule that made the `_local` / `_pep508_name`
promotion necessary. Name-agnostic on purpose — the chosen public names are
free, the leading underscore is not.
"""

import ast

from ._common import *  # noqa: F401,F403

_CORE = _PKG / "core.py"
_MANIFEST_CLAIM = "Never imports manifest or registry detail"


def _tree(path):
    return ast.parse(path.read_text(encoding="utf-8"))


class CoreCompositionTests(unittest.TestCase):
    def test_run_check_stays_a_thin_composer(self):
        func = next(n for n in _tree(_CORE).body
                    if isinstance(n, ast.FunctionDef) and n.name == "run_check")
        body_lines = func.end_lineno - func.body[0].lineno + 1
        self.assertLessEqual(
            body_lines, 45,
            f"run_check body is {body_lines} lines — stages belong in discovery/verify")

    def test_core_module_loc_budget(self):
        loc = len(_CORE.read_text(encoding="utf-8").splitlines())
        self.assertLessEqual(loc, 130, f"core.py is {loc} LOC")

    def test_core_has_no_registry_name_branch(self):
        src = _CORE.read_text(encoding="utf-8")
        self.assertNotIn('== "go"', src)
        self.assertNotIn("registry.name ==", src)

    def test_core_composes_the_two_stages(self):
        src = _CORE.read_text(encoding="utf-8")
        self.assertIn("from .discovery import", src)
        self.assertIn("from .verify import", src)

    def test_docstring_drops_the_manifest_claim(self):
        doc = ast.get_docstring(_tree(_CORE)) or ""
        self.assertNotIn(_MANIFEST_CLAIM, doc)


class StageBoundaryTests(unittest.TestCase):
    def test_new_stages_do_not_import_cli_or_transport(self):
        for name in ("discovery.py", "verify.py"):
            src = (_PKG / name).read_text(encoding="utf-8")
            for banned in ("from .cli import", "from .transport import",
                           "import cli", "import transport"):
                self.assertNotIn(banned, src, f"{name} must not reach {banned}")

    def test_no_sibling_private_imports(self):
        offenders = []
        for path in sorted(_PKG.rglob("*.py")):
            for node in ast.walk(_tree(path)):
                if not isinstance(node, ast.ImportFrom):
                    continue
                if node.module == "__future__" or not node.module:
                    continue
                if node.level == 0 and not node.module.startswith(
                        "dependency_existence_check"):
                    continue
                for alias in node.names:
                    if alias.name.startswith("_"):
                        rel = path.relative_to(_PKG)
                        offenders.append(f"{rel}:{node.lineno} imports {alias.name}")
        self.assertEqual(offenders, [])


class ShimSurfaceTests(unittest.TestCase):
    def test_path_re_export_dropped(self):
        self.assertFalse(hasattr(dec, "Path"))
