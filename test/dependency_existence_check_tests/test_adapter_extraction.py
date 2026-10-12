"""Per-ecosystem adapter extraction — Python/JS/Go family.

Split from test/dependency-existence-check.test.py (issue #2005 Long File refactor).
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401
from ._bases import AdapterExtractionBase  # noqa: E402

class AdapterExtractionTests(AdapterExtractionBase):
    def test_python_requirements(self):
        a = dec.PythonAdapter()
        td = tempfile.TemporaryDirectory()
        try:
            inc = Path(td.name) / "constraints.txt"
            inc.write_text("urllib3==2.0.0\n")
            req = Path(td.name) / "requirements.txt"
            req.write_text(
                "# comment\n\n"
                "requests==2.31.0\n"
                "flask>=3.0\n"
                "click[extra]~=8.1\n"
                "-r constraints.txt\n"
                "-e git+https://github.com/x/y.git#egg=y\n"
                "git+https://github.com/x/z.git\n"
                "https://example.com/pkg.whl\n"
                "local_pkg; python_version < '3.12'\n"
            )
            deps = self.names(a, req.read_text(), req)
            names = {n for n, _ in deps}
            self.assertEqual(names, {"requests", "flask", "click", "urllib3", "local_pkg"})
        finally:
            td.cleanup()

    def test_python_pyproject_and_poetry(self):
        a = dec.PythonAdapter()
        text = (
            "[project]\n"
            'dependencies = ["requests>=2.0", "flask"]\n'
            "[project.optional-dependencies]\n"
            'test = ["pytest>=7", "coverage"]\n'
            "[tool.poetry.dependencies]\n"
            'python = "^3.11"\n'
            'requests = "^2.31"\n'
            'local = {path = "../local"}\n'
            "[tool.poetry.dev-dependencies]\n"
            'black = "*"\n'
        )
        names = {n for n, _ in self.names(a, text, self.P("pyproject.toml"))}
        self.assertEqual(names, {"requests", "flask", "pytest", "coverage", "black"})

    def test_python_pipfile(self):
        a = dec.PythonAdapter()
        text = (
            "[packages]\n"
            'requests = "*"\n'
            'flask = {version = "==3.0.0"}\n'
            'local = {path = "."}\n'
            'gitdep = {git = "https://x/y.git"}\n'
            "[dev-packages]\n"
            'pytest = "*"\n'
        )
        names = {n for n, _ in self.names(a, text, self.P("Pipfile"))}
        self.assertEqual(names, {"requests", "flask", "pytest"})

    def test_python_setup_cfg_and_setup_py(self):
        a = dec.PythonAdapter()
        cfg = "[options]\ninstall_requires =\n    requests>=2.0\n    flask\n"
        self.assertEqual({n for n, _ in self.names(a, cfg, self.P("setup.cfg"))},
                         {"requests", "flask"})
        py = ('from setuptools import setup\n'
              'setup(name="x", install_requires=["requests>=2.0", "flask"])\n'
              'install_requires = ["pytest"]\n')
        self.assertEqual({n for n, _ in self.names(a, py, self.P("setup.py"))},
                         {"requests", "flask", "pytest"})
        self.assertEqual(self.names(a, "print('not a setup')\n", self.P("setup.py")), [])

    def test_js_package_json_sections_and_scoped_names(self):
        a = dec.JavaScriptAdapter()
        text = json.dumps({
            "dependencies": {"@scope/pkg": "^1.0.0", "plain": "2.0.0"},
            "devDependencies": {"devdep": "1.0.0"},
            "peerDependencies": {"peerdep": "1.0.0"},
            "optionalDependencies": {"optdep": "1.0.0"},
        })
        names = {n for n, _ in self.names(a, text, self.P("package.json"))}
        self.assertEqual(names, {"@scope/pkg", "plain", "devdep", "peerdep", "optdep"})

    def test_go_mod(self):
        a = dec.GoAdapter()
        text = (
            "module github.com/me/proj\n\n"
            "go 1.21\n\n"
            "require (\n"
            "\tgithub.com/foo/bar v1.2.3\n"
            "\tgolang.org/x/mod v0.14.0 // indirect\n"
            "\tgithub.com/keep v0.1.0 // indirect\n"
            ")\n\n"
            "require github.com/single/one v2.0.0\n"
            "replace github.com/foo/bar => github.com/foo/bar v1.2.4\n"
            "exclude github.com/old v0.0.1\n"
        )
        names = {n for n, _ in self.names(a, text, self.P("go.mod"))}
        self.assertEqual(names, {"github.com/foo/bar", "github.com/single/one"})
