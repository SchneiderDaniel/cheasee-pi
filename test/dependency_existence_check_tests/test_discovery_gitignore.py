"""Manifest discovery and .gitignore handling.

Split from test/dependency-existence-check.test.py (issue #2005 Long File refactor).
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401

class DiscoveryAndGitignoreTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def test_gitignore_matcher_pattern_classes(self):
        td, repo = write_repo({".gitignore": "\n".join([
            "# comment",
            "*.log",
            "build/",
            "/rooted.txt",
            "sub/keep.txt",
            "**/generated",
            "a/**/deep.txt",
            "doc?x.txt",
            "[ab].txt",
            "!keep.log",
            "",
        ])})
        try:
            m = dec.GitignoreMatcher(repo)
            m.load_dir(repo)
            # * unanchored, any depth
            self.assertTrue(m.matches(Path("a.log")))
            self.assertTrue(m.matches(Path("x/y/a.log")))
            self.assertFalse(m.matches(Path("x.txt")))
            # dir-only trailing /
            self.assertTrue(m.matches(Path("build"), is_dir=True))
            self.assertFalse(m.matches(Path("build"), is_dir=False))
            self.assertTrue(m.matches(Path("x/build"), is_dir=True))
            # /-anchored to root
            self.assertTrue(m.matches(Path("rooted.txt")))
            self.assertFalse(m.matches(Path("sub/rooted.txt")))
            # anchored path
            self.assertTrue(m.matches(Path("sub/keep.txt")))
            self.assertFalse(m.matches(Path("keep.txt")))
            self.assertFalse(m.matches(Path("other/sub/keep.txt")))
            # ** prefix
            self.assertTrue(m.matches(Path("generated")))
            self.assertTrue(m.matches(Path("a/b/generated")))
            self.assertFalse(m.matches(Path("generated.txt")))
            # ** mid
            self.assertTrue(m.matches(Path("a/x/y/deep.txt")))
            self.assertTrue(m.matches(Path("a/deep.txt")))
            self.assertFalse(m.matches(Path("b/deep.txt")))
            # ?
            self.assertTrue(m.matches(Path("docax.txt")))
            self.assertFalse(m.matches(Path("docx.txt")))
            # [...]
            self.assertTrue(m.matches(Path("a.txt")))
            self.assertFalse(m.matches(Path("c.txt")))
            # ! negation (with *.log above)
            self.assertFalse(m.matches(Path("keep.log")))
            self.assertTrue(m.matches(Path("drop.log")))
        finally:
            td.cleanup()

    def test_git_and_node_modules_always_skipped(self):
        td, repo = write_repo({
            ".gitignore": "!.git/**\n!node_modules/**\n",
            "node_modules/evil/package.json": json.dumps(
                {"dependencies": {"nope-js": "1.0.0"}}),
            ".git/package.json": json.dumps({"dependencies": {"nope-git": "1.0.0"}}),
            "package.json": json.dumps({"dependencies": {"alpha": "1.0.0"}}),
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("npm", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            names = {c["name"] for c in r["checked"]}
            self.assertEqual(names, {"alpha"})
        finally:
            td.cleanup()

    def test_manifests_detected_at_arbitrary_depth(self):
        td, repo = write_repo({"a/b/c/d/e/requirements.txt": "alpha\n"})
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(r["checked"][0]["source_file"], "a/b/c/d/e/requirements.txt")
        finally:
            td.cleanup()

    def test_content_sniffing_detection(self):
        # Pipfile / setup.py / conanfile.py need content sniffing, not just names.
        td, repo = write_repo({
            "Pipfile": '[packages]\nrequests = "*"\n',
            "setup.py": 'from setuptools import setup\n'
                        'setup(name="x", install_requires=["flask>=2.0"])\n',
            "conanfile.py": 'from conans import ConanFile\n'
                            'class X(ConanFile):\n    requires = "openssl/3.0.0"\n',
            "not-a-manifest.py": "print('hello')\n",  # negative case
        })
        try:
            fetcher = FakeFetcher(routes=dict([
                ok_route("pypi", "requests"), ok_route("pypi", "flask"),
                ok_route("conan", "openssl"),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0, r["failures"])
            names = {c["name"] for c in r["checked"]}
            self.assertEqual(names, {"requests", "flask", "openssl"})
        finally:
            td.cleanup()

    def test_gitignored_manifests_skipped(self):
        td, repo = write_repo({
            ".gitignore": "vendored/\nobj/\n",
            "vendored/package.json": json.dumps({"dependencies": {"vendored-js": "1.0.0"}}),
            "obj/App.csproj": "<Project><ItemGroup>"
                              '<PackageReference Include="obj-dotnet" /></ItemGroup></Project>',
            "package.json": json.dumps({"dependencies": {"alpha": "1.0.0"}}),
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("npm", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            names = {c["name"] for c in r["checked"]}
            self.assertEqual(names, {"alpha"})
        finally:
            td.cleanup()

    def test_lockfile_preferred_over_manifest(self):
        cases = [
            ("npm", {
                "package.json": json.dumps({"dependencies": {"alpha": "^1.0.0"}}),
                "package-lock.json": json.dumps({
                    "name": "root", "version": "1.0.0", "lockfileVersion": 3,
                    "packages": {
                        "": {"name": "root", "dependencies": {"alpha": "^1.0.0"}},
                        "node_modules/alpha": {"version": "1.2.3"},
                    },
                }),
            }, "alpha", "1.2.3"),
            ("crates", {
                "Cargo.toml": '[dependencies]\nalpha = "1"\n',
                "Cargo.lock": '[[package]]\nname = "alpha"\nversion = "1.5.0"\n',
            }, "alpha", "1.5.0"),
            ("rubygems", {
                "Gemfile": 'gem "alpha"\n',
                "Gemfile.lock": (
                    "GEM\n  remote: https://rubygems.org/\n  specs:\n"
                    "    alpha (2.0.0)\n\n"
                    "PLATFORMS\n  ruby\n\n"
                    "DEPENDENCIES\n  alpha\n"),
            }, "alpha", "2.0.0"),
            ("packagist", {
                "composer.json": json.dumps({"require": {"vendor/alpha": "^1.0"}}),
                "composer.lock": json.dumps({
                    "packages": [{"name": "vendor/alpha", "version": "1.3.0"}],
                }),
            }, "vendor/alpha", "1.3.0"),
            ("pub", {
                "pubspec.yaml": "name: x\ndependencies:\n  alpha: ^1.0.0\n",
                "pubspec.lock": (
                    "packages:\n  alpha:\n    dependency: \"direct main\"\n"
                    "    source: hosted\n    version: \"1.4.0\"\n"),
            }, "alpha", "1.4.0"),
        ]
        for reg, files, dep_name, lock_version in cases:
            td, repo = write_repo(files)
            try:
                fetcher = FakeFetcher(routes=dict([ok_route(reg, dep_name)]))
                code, out = run_main(["--root", str(repo), "--json"], fetcher)
                r = json.loads(out)
                self.assertEqual(code, 0, f"{reg}: {r['failures']}")
                self.assertEqual(len(r["checked"]), 1, reg)
                self.assertEqual(len(fetcher.requested_urls()), 1, reg)
                self.assertEqual(r["checked"][0]["version"], lock_version, reg)
            finally:
                td.cleanup()

    def test_non_manifest_lookalikes_ignored(self):
        td, repo = write_repo({
            "go.sum": "github.com/foo v1.0.0 h1:abc=\n",
            "node_modules/evil/package-lock.json": json.dumps({
                "packages": {"node_modules/evil": {"version": "1.0.0"}},
            }),
        })
        try:
            fetcher = FakeFetcher()  # no routes: any request fails the test
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(r["checked"], [])
        finally:
            td.cleanup()

    def test_transitive_off_by_default(self):
        pkgs = ["a", "b", "c", "d", "e", "f", "g"]
        lock = []
        for p in pkgs:
            block = f'[[package]]\nname = "{p}"\nversion = "1.0.0"\n'
            if p in ("a", "b"):
                block += "dependencies = [\n" + "\n".join(f' "{x}",' for x in pkgs[2:]) + "\n]\n"
            lock.append(block)
        td, repo = write_repo({"Cargo.lock": "\n".join(lock)})
        try:
            routes = dict([ok_route("crates", p) for p in pkgs])
            fetcher = FakeFetcher(routes=routes)
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(len(r["checked"]), 2)  # a, b direct only
            self.assertEqual(len(fetcher.requested_urls()), 2)
            fetcher2 = FakeFetcher(routes=routes)
            code2, out2 = run_main(["--root", str(repo), "--json", "--check-transitive"], fetcher2)
            r2 = json.loads(out2)
            self.assertEqual(code2, 0)
            self.assertEqual(len(r2["checked"]), 7)
            self.assertEqual(len(fetcher2.requested_urls()), 7)
        finally:
            td.cleanup()
