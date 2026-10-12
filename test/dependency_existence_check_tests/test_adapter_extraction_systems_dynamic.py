"""Per-ecosystem adapter extraction — systems/dynamic-language family.

Split from test/dependency-existence-check.test.py (issue #2005 Long File
refactor) and re-split by scenario (issue #2006 VBA God Module refactor); the
shared harness lives in `_bases.py`.
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401
from ._bases import AdapterExtractionBase  # noqa: E402

class AdapterExtractionSystemsDynamicTests(AdapterExtractionBase):
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
