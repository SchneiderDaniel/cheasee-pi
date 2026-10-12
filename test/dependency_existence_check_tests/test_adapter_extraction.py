"""Per-ecosystem adapter extraction.

Split from test/dependency-existence-check.test.py (issue #2005 Long File refactor).
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401

class AdapterExtractionTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def names(self, adapter, text, path=None):
        return [(d.name, d.version) for d in adapter.extract(text, path)]

    @staticmethod
    def P(name):
        return Path(name)

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

    def test_rust_cargo_toml_and_lock(self):
        a = dec.RustAdapter()
        toml = (
            "[dependencies]\n"
            'serde = "1.0"\n'
            'tokio = { version = "1.35", features = ["full"] }\n'
            'gitdep = { git = "https://x/y.git" }\n'
            'local = { path = "../local" }\n'
            "workspaced = { workspace = true }\n"
            "[dev-dependencies]\n"
            'criterion = "0.5"\n'
            "[build-dependencies]\n"
            'cc = "1.0"\n'
        )
        names = {n for n, _ in self.names(a, toml, self.P("Cargo.toml"))}
        self.assertEqual(names, {"serde", "tokio", "workspaced", "criterion", "cc"})
        lock = (
            '[[package]]\nname = "serde"\nversion = "1.0.200"\n'
            'dependencies = [\n "serde_derive",\n]\n\n'
            '[[package]]\nname = "serde_derive"\nversion = "1.0.200"\n'
        )
        deps = self.names(a, lock, self.P("Cargo.lock"))
        by_name = dict(deps)
        self.assertEqual(by_name["serde"], "1.0.200")
        extracted = a.extract(lock, self.P("Cargo.lock"))
        by_name2 = {d.name: d for d in extracted}
        self.assertEqual(set(by_name2), {"serde", "serde_derive"})
        self.assertTrue(by_name2["serde_derive"].transitive)  # referenced by serde
        self.assertFalse(by_name2["serde"].transitive)  # root of the graph

    def test_rust_cargo_lock_skips_own_crate(self):
        # The crate's own package (named in the sibling Cargo.toml) is local,
        # never a crates.io registry entry, and must not be reported.
        a = dec.RustAdapter()
        td = tempfile.TemporaryDirectory()
        try:
            d = Path(td.name)
            (d / "Cargo.toml").write_text(
                '[package]\nname = "my-local-crate"\nversion = "0.1.0"\n'
                "[dependencies]\nserde = \"1\"\n"
            )
            lock = (
                '[[package]]\nname = "my-local-crate"\nversion = "0.1.0"\n'
                "dependencies = [\n \"serde\",\n]\n\n"
                '[[package]]\nname = "serde"\nversion = "1.0.200"\n'
            )
            extracted = a.extract(lock, d / "Cargo.lock")
            self.assertEqual([x.name for x in extracted], ["serde"])
            self.assertTrue(extracted[0].transitive)  # referenced by the skipped root crate
        finally:
            td.cleanup()

    def test_java_pom_xml(self):
        a = dec.JavaAdapter()
        text = (
            '<project xmlns="http://maven.apache.org/POM/4.0.0">'
            "<dependencies>"
            "<dependency><groupId>com.example</groupId><artifactId>lib</artifactId>"
            "<version>1.2</version><scope>test</scope></dependency>"
            "<dependency><groupId>org.foo</groupId><artifactId>bar</artifactId></dependency>"
            "</dependencies></project>"
        )
        deps = dict(self.names(a, text, self.P("pom.xml")))
        self.assertEqual(deps, {"com.example:lib": "1.2", "org.foo:bar": None})

    def test_java_gradle(self):
        a = dec.JavaAdapter()
        text = (
            "dependencies {\n"
            "    implementation 'com.example:lib:1.2'\n"
            "    api group: 'org.foo', name: 'bar', version: '2.0'\n"
            "    compileOnly 'com.opt:opt:1.0'\n"
            "    implementation(\n"
            "        group: 'com.multi',\n"
            "        name: 'multi',\n"
            "        version: '3.0'\n"
            "    )\n"
            "    testImplementation 'junit:junit:4.13'\n"
            "}\n"
        )
        names = {n for n, _ in self.names(a, text, self.P("build.gradle"))}
        self.assertEqual(names, {"com.example:lib", "org.foo:bar", "com.opt:opt",
                                 "com.multi:multi", "junit:junit"})

    def test_dotnet_csproj_packages_config_and_central(self):
        a = dec.DotnetAdapter()
        csproj = (
            '<Project Sdk="Microsoft.NET.Sdk">'
            "<ItemGroup>"
            '<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />'
            '<PackageReference Include="NoVersion" />'
            '<ProjectReference Include="../Other/Other.csproj" />'
            "</ItemGroup></Project>"
        )
        names = {n for n, _ in self.names(a, csproj, self.P("App.csproj"))}
        self.assertEqual(names, {"Newtonsoft.Json", "NoVersion"})
        pc = '<packages><package id="log4net" version="2.0.8" /></packages>'
        self.assertEqual(dict(self.names(a, pc, self.P("packages.config"))), {"log4net": "2.0.8"})
        props = (
            "<Project><ItemGroup>"
            '<PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />'
            "</ItemGroup></Project>"
        )
        self.assertEqual(dict(self.names(a, props, self.P("Directory.Packages.props"))),
                         {"Newtonsoft.Json": "13.0.3"})

    def test_cpp_vcpkg_and_conan(self):
        a = dec.CppAdapter()
        vcpkg = json.dumps({
            "name": "app",
            "dependencies": ["zlib", {"name": "libpng", "host": True}],
            "host-dependencies": ["cmake"],
        })
        names = {n for n, _ in self.names(a, vcpkg, self.P("vcpkg.json"))}
        self.assertEqual(names, {"zlib", "libpng", "cmake"})
        txt = "[requires]\nopenssl/3.0.0\nboost/1.83.0@user/channel\n"
        self.assertEqual({n for n, _ in self.names(a, txt, self.P("conanfile.txt"))},
                         {"openssl", "boost"})
        py = 'class X(ConanFile):\n    requires = ("openssl/3.0.0", "zlib/1.3")\n'
        self.assertEqual({n for n, _ in self.names(a, py, self.P("conanfile.py"))},
                         {"openssl", "zlib"})
        lock = json.dumps({"graph_lock": {"nodes": {
            "0": {"ref": "app/1.0.0", "requires": ["openssl/3.0.0#r1"]},
        }}})
        self.assertEqual({n for n, _ in self.names(a, lock, self.P("conan.lock"))}, {"openssl"})

    def test_ruby_gemfile_lock_and_gemspec(self):
        a = dec.RubyAdapter()
        gemfile = (
            'source "https://rubygems.org"\n'
            'gem "rails", "~> 7.0"\n'
            "gem 'sinatra'\n"
            'gem "gitgem", git: "https://x/y.git"\n'
            'gem "pathgem", path: "../local"\n'
        )
        self.assertEqual({n for n, _ in self.names(a, gemfile, self.P("Gemfile"))},
                         {"rails", "sinatra"})
        lock = (
            "GIT\n  remote: https://x/y.git\n  revision: abc\n  specs:\n"
            "    gitgem (1.0.0)\n\n"
            "GEM\n  remote: https://rubygems.org/\n  specs:\n"
            "    activesupport (7.0.0)\n"
            "    rails (7.0.0)\n"
            "      activesupport (= 7.0.0)\n\n"
            "PLATFORMS\n  ruby\n\n"
            "DEPENDENCIES\n  rails (~> 7.0)\n"
        )
        deps = a.extract(lock, self.P("Gemfile.lock"))
        by_name = {d.name: d for d in deps}
        self.assertEqual(set(by_name), {"activesupport", "rails"})
        self.assertFalse(by_name["rails"].transitive)  # listed in DEPENDENCIES
        self.assertTrue(by_name["activesupport"].transitive)
        gemspec = ('Gem::Specification.new do |s|\n'
                   '  s.add_runtime_dependency "rack", ">= 2.0"\n'
                   '  s.add_development_dependency "rspec", "~> 3.0"\n'
                   '  s.add_dependency "json"\n'
                   'end\n')
        self.assertEqual({n for n, _ in self.names(a, gemspec, self.P("x.gemspec"))},
                         {"rack", "rspec", "json"})

    def test_php_composer(self):
        a = dec.PhpAdapter()
        composer = json.dumps({
            "require": {"vendor/pkg": "^2.0", "php": ">=8.0", "ext-json": "*", "lib-curl": "*"},
            "require-dev": {"vendor/dev": "^1.0"},
        })
        self.assertEqual({n for n, _ in self.names(a, composer, self.P("composer.json"))},
                         {"vendor/pkg", "vendor/dev"})
        lock = json.dumps({
            "packages": [{"name": "vendor/pkg", "version": "2.3.0"}],
            "packages-dev": [{"name": "vendor/dev", "version": "1.1.0"}],
        })
        self.assertEqual(dict(self.names(a, lock, self.P("composer.lock"))),
                         {"vendor/pkg": "2.3.0", "vendor/dev": "1.1.0"})

    def test_swift_package(self):
        a = dec.SwiftAdapter()
        text = (
            "// swift-tools-version:5.9\n"
            "import PackageDescription\n"
            'let package = Package(name: "x", dependencies: [\n'
            '    .package(url: "https://github.com/vapor/vapor.git", from: "4.0.0"),\n'
            '    .package(url: "https://github.com/pointfreeco/swift-composable-architecture", from: "1.0.0"),\n'
            '    .package(path: "../local"),\n'
            "])\n"
        )
        names = {n for n, _ in self.names(a, text, self.P("Package.swift"))}
        self.assertEqual(names, {"vapor/vapor", "pointfreeco/swift-composable-architecture"})

    def test_dart_pubspec(self):
        a = dec.DartAdapter()
        yaml = (
            "name: x\n"
            "environment:\n"
            "  sdk: '>=3.0.0'\n"
            "dependencies:\n"
            "  flutter:\n"
            "    sdk: flutter\n"
            "  http: ^1.0.0\n"
            "  gitdep:\n"
            "    git:\n"
            "      url: https://x/y.git\n"
            "  pathdep:\n"
            "    path: ../local\n"
            "dev_dependencies:\n"
            "  lints: ^3.0.0\n"
        )
        self.assertEqual({n for n, _ in self.names(a, yaml, self.P("pubspec.yaml"))},
                         {"http", "lints"})
        lock = (
            "packages:\n"
            "  http:\n"
            '    dependency: "direct main"\n'
            "    description:\n"
            "      name: http\n"
            "      sha256: abc\n"
            '    version: "1.1.0"\n'
            "  lints:\n"
            '    dependency: "direct dev"\n'
            '    version: "3.0.0"\n'
            "  matcher:\n"
            "    dependency: transitive\n"
            '    version: "0.0.1"\n'
        )
        deps = a.extract(lock, self.P("pubspec.lock"))
        by_name = {d.name: d for d in deps}
        self.assertEqual(by_name["http"].version, "1.1.0")
        self.assertFalse(by_name["http"].transitive)
        self.assertFalse(by_name["lints"].transitive)
        self.assertTrue(by_name["matcher"].transitive)
