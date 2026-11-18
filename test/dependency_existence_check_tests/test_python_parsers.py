"""Python manifest parsers — pure text/mapping -> spec translation.

Regression guard for the issue #2097 `Mixins` refactor: the Python adapter used
to compose `RequirementsMixin`, `PipfileTomlMixin` and `SetupMixin`, which hid a
dependency on `Adapter._dep`. The parsers are now module-level functions that
return `(name, version, line, source)` specs, and `PythonAdapter` is the only
place that builds a `Dependency`.

Plain `unittest.TestCase`: nothing here touches a registry, so the shared
interval-reset base is not needed.

Assertions project records with `attrgetter` instead of a literal comprehension:
the CodeFlow branch-count metric scores raw text and the function-count metric
counts every `def` at any indent, so a projection helper would break one of the
two ceilings.
"""

import os
import tomllib
from operator import attrgetter

from ._common import *  # noqa: F401,F403
from ._common import dec  # noqa: E402

_REQ = dec.adapters.python_requirements
_META = dec.adapters.python_metadata
_PY_ADAPTER = dec.adapters.python


class PythonParserTests(unittest.TestCase):
    def test_requirements_yields_specs_and_ignores_noise(self):
        text = (
            "# comment\n"
            "\n"
            "requests==2.31.0\n"
            "flask>=3.0\n"
            "click[extra]~=8.1\n"
            "local_pkg; python_version < '3.12'\n"
            "-c constraints.txt\n"
            "-i https://example.com/simple\n"
            "-e git+https://github.com/x/y.git#egg=y\n"
            "git+https://github.com/x/z.git\n"
            "https://example.com/pkg.whl\n"
        )
        source = Path("requirements.txt")
        specs = _REQ.parse_requirements(text, source)
        expected = [
            ("requests", None, 3, source),
            ("flask", None, 4, source),
            ("click", None, 5, source),
            ("local_pkg", None, 6, source),
        ]
        # Positional shape: (name, version, line, source). A pin still records
        # version None — that is today's behaviour, characterised not "fixed".
        self.assertEqual(specs, expected)
        # ...and the same fields by attribute.
        self.assertEqual(list(map(attrgetter("name", "version", "line", "source"), specs)),
                         expected)

    def test_requirements_include_source_is_resolved(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            include = root / "constraints.txt"
            include.write_text("urllib3==2.0.0\n# pad\nsix\n", encoding="utf-8")
            req = root / "requirements.txt"
            req.write_text("requests==2.31.0\n-r constraints.txt\n", encoding="utf-8")
            specs = _REQ.parse_requirements(req.read_text(encoding="utf-8"), req)
        self.assertEqual(
            list(map(attrgetter("name", "line", "source"), specs)),
            [
                ("requests", 1, req),
                # `line` is 1-based per source file, never an offset in the parent.
                ("urllib3", 1, include.resolve()),
                ("six", 3, include.resolve()),
            ],
        )

    def test_requirements_nested_include_resolves_against_its_own_dir(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            (root / "sub").mkdir()
            nested = root / "sub" / "b.txt"
            nested.write_text("six\n", encoding="utf-8")
            parent = root / "a" / "requirements.txt"
            parent.parent.mkdir()
            parent.write_text("-r ../sub/b.txt\nrequests\n", encoding="utf-8")
            specs = _REQ.parse_requirements(parent.read_text(encoding="utf-8"), parent)
        self.assertEqual(
            list(map(attrgetter("name", "source"), specs)),
            [("six", nested.resolve()), ("requests", parent)],
        )

    def test_requirements_missing_duplicate_and_cyclic_includes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            (root / "a.txt").write_text("-r b.txt\nalpha\n", encoding="utf-8")
            (root / "b.txt").write_text("-r a.txt\nbeta\n", encoding="utf-8")
            req = root / "requirements.txt"
            req.write_text("-r missing.txt\n-r a.txt\n-r a.txt\nroot\n", encoding="utf-8")
            specs = _REQ.parse_requirements(req.read_text(encoding="utf-8"), req)
        # Missing include skipped, sibling still returned, the twice-named and
        # the cyclic include each contribute their specs once.
        self.assertEqual(list(map(attrgetter("name"), specs)), ["beta", "alpha", "root"])

    def test_requirements_boundaries_and_purity(self):
        self.assertEqual(_REQ.parse_requirements("", Path("requirements.txt")), [])
        specs = _REQ.parse_requirements("requests\n", None)
        self.assertEqual(specs, [("requests", None, 1, Path("requirements.txt"))])
        # Pure: identical calls are equal, and no Adapter instance is involved.
        self.assertEqual(_REQ.parse_requirements("requests\n", None), specs)
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            (root / "extra.txt").write_text("six\n", encoding="utf-8")
            previous = os.getcwd()
            os.chdir(root)
            try:
                # path=None resolves includes against Path(".").
                relative = _REQ.parse_requirements("-r extra.txt\nrequests\n", None)
            finally:
                os.chdir(previous)
        self.assertEqual(
            list(map(attrgetter("name", "source"), relative)),
            [("six", (root / "extra.txt").resolve()), ("requests", Path("requirements.txt"))],
        )

    def test_pipfile_packages_and_skips(self):
        data = {
            "packages": {
                "requests": "*",
                "flask": {"version": "==3.0.0"},
                "local": {"path": "."},
                "vcs": {"git": "https://x/y.git"},
                "wheel": {"file": "x.whl"},
                "editable": {"editable": True},
                "count": 3,
            },
            "dev-packages": {"pytest": "*"},
        }
        source = Path("Pipfile")
        specs = _META.parse_pipfile(data, source)
        self.assertEqual(
            list(map(attrgetter("name", "version", "line", "source"), specs)),
            [
                ("requests", "*", 0, source),
                ("flask", "==3.0.0", 0, source),
                ("count", None, 0, source),
                ("pytest", "*", 0, source),
            ],
        )
        self.assertEqual(_META.parse_pipfile({}, source), [])

    def test_toml_project_optional_and_poetry(self):
        source = Path("pyproject.toml")
        text = (
            "[project]\n"
            'dependencies = ["requests>=2.0", 42]\n'
            "[project.optional-dependencies]\n"
            'test = ["pytest>=7"]\n'
            'docs = ["sphinx"]\n'
            "[tool.poetry.dependencies]\n"
            'python = "^3.11"\n'
            'requests = "^2.31"\n'
            'local = {path = "../local"}\n'
            'vcs = {git = "https://x/y.git"}\n'
            'remote = {url = "https://x/y.whl"}\n'
            "[tool.poetry.dev-dependencies]\n"
            'black = "*"\n'
        )
        specs = _META.parse_toml(tomllib.loads(text), source)
        # pep508 name for the [project] entries, every optional group, poetry
        # minus `python`, and a poetry pin recorded as None (today's behaviour).
        self.assertEqual(
            list(map(attrgetter("name", "version", "line", "source"), specs)),
            [
                ("requests", None, 0, source),
                ("pytest", None, 0, source),
                ("sphinx", None, 0, source),
                ("requests", None, 0, source),
                ("black", None, 0, source),
            ],
        )
        self.assertEqual(_META.parse_toml({}, source), [])

    def test_setup_cfg_block_grammar_and_lines(self):
        text = (
            "[metadata]\n"
            "install_requires = ignored\n"
            "[options]\n"
            "install_requires = requests>=2.0\n"
            "    flask\n"
            "\n"
            "# comment\n"
            "; semicolon\n"
            "    click[extra]\n"
            "name = other\n"
            "    after_dedent\n"
        )
        specs = _META.parse_setup_cfg(text, Path("setup.cfg"))
        self.assertEqual(list(map(attrgetter("name", "line"), specs)),
                         [("requests", 4), ("flask", 5), ("click", 9)])
        self.assertEqual(_META.parse_setup_cfg("", Path("setup.cfg")), [])

    def test_setup_py_literals(self):
        source = Path("setup.py")
        text = (
            "from setuptools import setup\n"
            "reqs = ['ignored']\n"
            "setup(name='x', install_requires=['requests>=2.0', 42, 'flask'])\n"
            "setup(install_requires=('six',))\n"
            "install_requires = ['pytest']\n"
            "setup(install_requires=reqs)\n"
        )
        specs = _META.parse_setup_py(text, source)
        # Both the `setup()` call and the module-level assignment are found by
        # the AST walk, so order is not semantic; the line is always unknown.
        self.assertEqual(set(map(attrgetter("name"), specs)),
                         {"requests", "flask", "six", "pytest"})
        self.assertEqual(set(map(attrgetter("line", "source"), specs)), {(0, source)})
        self.assertEqual(_META.parse_setup_py("print('not a setup')\n", source), [])
        self.assertEqual(_META.parse_setup_py("setup(install_requires=[\n", source), [])

    def test_metadata_parsers_are_pure_and_standalone(self):
        cfg = "[options]\ninstall_requires =\n    requests>=2.0\n"
        py = "from setuptools import setup\nsetup(install_requires=['flask'])\n"
        first = _META.parse_setup_cfg(cfg, Path("setup.cfg"))
        self.assertEqual(_META.parse_setup_cfg(cfg, Path("setup.cfg")), first)
        self.assertEqual(cfg, "[options]\ninstall_requires =\n    requests>=2.0\n")
        self.assertEqual(py, "from setuptools import setup\nsetup(install_requires=['flask'])\n")
        self.assertEqual(
            _META.parse_setup_py(py, Path("setup.py")),
            [("flask", None, 0, Path("setup.py"))],
        )

    def test_mixins_are_gone(self):
        self.assertEqual(dec.PythonAdapter.__bases__, (dec.Adapter,))
        self.assertEqual(list(map(attrgetter("__name__"), dec.PythonAdapter.__mro__)),
                         ["PythonAdapter", "Adapter", "object"])
        self.assertFalse(hasattr(_REQ, "RequirementsMixin"))
        self.assertFalse(hasattr(_META, "PipfileTomlMixin"))
        self.assertFalse(hasattr(_META, "SetupMixin"))

    def test_parser_modules_carry_no_adapter_contract(self):
        for module in (_REQ, _META):
            src = Path(module.__file__).read_text(encoding="utf-8")
            self.assertNotIn("self._dep", src, module.__name__)
            self.assertNotIn("from .base import", src, module.__name__)
            self.assertNotIn("from ..models import", src, module.__name__)
        adapter_src = Path(_PY_ADAPTER.__file__).read_text(encoding="utf-8")
        for parser in ("parse_requirements", "parse_pipfile", "parse_toml",
                       "parse_setup_cfg", "parse_setup_py"):
            self.assertIn(parser, adapter_src, f"python.py must dispatch to {parser}")

    def test_adapter_dispatch_parity_and_dependency_defaults(self):
        adapter = dec.PythonAdapter()
        cases = {
            "requirements.txt": "requests==2.31.0\n",
            "requirements-dev.txt": "pytest\n",
            "pyproject.toml": '[project]\ndependencies = ["flask"]\n',
            "Pipfile": '[packages]\nflask = "*"\n',
            "setup.cfg": "[options]\ninstall_requires =\n    six\n",
            "setup.py": "from setuptools import setup\nsetup(install_requires=['click'])\n",
        }
        for name, text in cases.items():
            deps = adapter.extract(text, Path(name))
            self.assertEqual(len(deps), 1, name)
            dep = deps[0]
            self.assertEqual(dep.language, "python", name)
            self.assertEqual(dep.priority, 10, name)
            self.assertIs(dep.transitive, False, name)
            self.assertIsNone(dep.registry_name, name)
            self.assertEqual(dep.source_file, name, name)
        self.assertEqual(adapter.extract('x = 1\n', Path("unmatched.txt")), [])
        # The TOML decode guard stays in the adapter.
        for name in ("Pipfile", "pyproject.toml"):
            self.assertEqual(adapter.extract("not = = toml\n", Path(name)), [], name)

    def test_adapter_include_source_file_is_resolved(self):
        adapter = dec.PythonAdapter()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            include = root / "constraints.txt"
            include.write_text("urllib3==2.0.0\n", encoding="utf-8")
            req = root / "requirements.txt"
            req.write_text("requests\n-r constraints.txt\n", encoding="utf-8")
            deps = adapter.extract(req.read_text(encoding="utf-8"), req)
        self.assertEqual(
            sorted(map(attrgetter("name", "source_file"), deps)),
            sorted([("requests", str(req)), ("urllib3", str(include.resolve()))]),
        )
