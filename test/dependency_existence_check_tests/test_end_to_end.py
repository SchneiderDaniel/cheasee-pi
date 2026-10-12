"""End-to-end runs over the real worktree.

Split from test/dependency-existence-check.test.py (issue #2005 Long File refactor).
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401

class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def test_e2e_real_worktree(self):
        repo = _HERE.parent  # the real worktree (package.json + go.mod + Cargo.lock + submanifests)
        fetcher = FakeFetcher(default=make_response)
        code, out = run_main(["--root", str(repo), "--json"], fetcher)
        r = json.loads(out)
        self.assertEqual(code, 0, r["failures"])
        self.assertTrue(r["checked"])
        urls = fetcher.requested_urls()
        # Cross-manifest dedupe: no URL requested twice.
        self.assertEqual(len(urls), len(set(urls)))
        # Only known registries were touched.
        for u in urls:
            self.assertTrue(any(h in u for h in (
                "registry.npmjs.org", "proxy.golang.org", "pypi.org", "rubygems.org",
                "crates.io",
            )), u)
        # Root package.json direct dep resolved from package-lock.json.
        lock = json.loads((repo / "package-lock.json").read_text())
        entry = next(c for c in r["checked"]
                     if c["language"] == "javascript" and c["name"] == "@octokit/graphql")
        expected = lock["packages"]["node_modules/@octokit/graphql"]["version"]
        self.assertEqual(entry["version"], expected)
        # Transitive-only names (not direct anywhere in the tree) are not requested.
        direct = set((lock["packages"][""].get("dependencies") or {}))
        direct |= set((lock["packages"][""].get("devDependencies") or {}))
        other_direct = set()
        for p in repo.rglob("package.json"):
            if "node_modules" in p.parts or ".git" in p.parts:
                continue
            if p.resolve() == (repo / "package.json").resolve():
                continue
            try:
                d = json.loads(p.read_text())
            except Exception:
                continue
            for sec in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
                other_direct.update((d.get(sec) or {}).keys())
        transitive_only = {
            k.split("node_modules/")[-1] for k in lock["packages"]
            if k.startswith("node_modules/") and k.split("node_modules/")[-1] not in direct
        }
        npm_requested = {urllib.parse.unquote(urllib.parse.urlparse(u).path.lstrip("/"))
                         for u in urls if _netloc(u) == "registry.npmjs.org"}
        for n in transitive_only - other_direct:
            self.assertNotIn(n, npm_requested, f"transitive {n} was requested")

    def test_e2e_mixed_fixture_all_languages(self):
        fixtures = {
            "requirements.txt": "exists-py\nmissing-py\nyoung-py\n",
            "package.json": json.dumps({"dependencies": {
                "exists-js": "1.0.0", "missing-js": "1.0.0", "down-js": "1.0.0",
            }}),
            "go.mod": ("module example.com/m\n\ngo 1.21\n\nrequire (\n"
                       "\texists-go v1.0.0\n\tmissing-go v1.0.0\n)\n"),
            "Cargo.toml": '[dependencies]\nexists-rust = "1"\nmissing-rust = "1"\n',
            "pom.xml": (
                "<project><dependencies>"
                "<dependency><groupId>com.example</groupId><artifactId>exists-java</artifactId>"
                "<version>1.0</version></dependency>"
                "<dependency><groupId>com.example</groupId><artifactId>missing-java</artifactId>"
                "</dependency>"
                "</dependencies></project>"),
            "app.csproj": (
                "<Project><ItemGroup>"
                '<PackageReference Include="exists-dotnet" Version="1.0.0" />'
                '<PackageReference Include="missing-dotnet" />'
                "</ItemGroup></Project>"),
            "conanfile.txt": "[requires]\nexists-cpp/1.0.0\nmissing-cpp/1.0.0\n",
            "Gemfile": 'gem "exists-ruby"\ngem "missing-ruby"\n',
            "composer.json": json.dumps({"require": {
                "exists/vendor-php": "^1.0", "missing/vendor-php": "^1.0",
            }}),
            "Package.swift": (
                "// swift-tools-version:5.9\nimport PackageDescription\n"
                'let p = Package(name: "x", dependencies: [\n'
                '    .package(url: "https://github.com/owner/exists-swift.git", from: "1.0.0"),\n'
                '    .package(url: "https://github.com/owner/missing-swift.git", from: "1.0.0"),\n'
                "])\n"),
            "pubspec.yaml": (
                "name: x\ndependencies:\n  exists-dart: ^1.0.0\n  missing-dart: ^1.0.0\n"),
        }
        td, repo = write_repo(fixtures)
        try:
            routes = {}
            for n in ("exists-py", "exists-js", "exists-go", "exists-rust",
                      "exists-dotnet", "exists-ruby", "exists-dart"):
                reg = {"exists-py": "pypi", "exists-js": "npm", "exists-go": "go",
                       "exists-rust": "crates", "exists-dotnet": "nuget",
                       "exists-ruby": "rubygems", "exists-dart": "pub"}[n]
                routes.update([ok_route(reg, n)])
            routes.update([ok_route("conan", "exists-cpp")])
            routes.update([ok_route("packagist", "exists/vendor-php")])
            routes.update([ok_route("swift", "owner/exists-swift")])
            routes.update([ok_route("maven", "com.example:exists-java")])
            routes.update([ok_route("maven-version", "com.example:exists-java")])
            for n in ("missing-py", "missing-js", "missing-go", "missing-rust",
                      "missing-dotnet", "missing-ruby", "missing-dart"):
                reg = {"missing-py": "pypi", "missing-js": "npm", "missing-go": "go",
                       "missing-rust": "crates", "missing-dotnet": "nuget",
                       "missing-ruby": "rubygems", "missing-dart": "pub"}[n]
                routes.update([not_found_route(reg, n)])
            routes.update([not_found_route("conan", "missing-cpp")])
            routes.update([not_found_route("packagist", "missing/vendor-php")])
            routes.update([not_found_route("swift", "owner/missing-swift")])
            routes.update([not_found_route("maven", "com.example:missing-java")])
            routes.update([ok_route("pypi", "young-py", iso_days_ago(3))])

            def down():
                raise ConnectionError("registry down")

            routes[url_for("npm", "down-js")] = (down, "", None)

            fetcher = FakeFetcher(routes=routes)
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            self.assertFalse(r["ok"])
            by_reason = {}
            for f in r["failures"]:
                by_reason.setdefault(f["reason"], []).append(f)
                self.assertTrue(f["source_file"], f)
                self.assertIsInstance(f["line"], int)
            self.assertIn("not-found", by_reason)
            self.assertIn("too-young", by_reason)
            self.assertIn("registry-unreachable", by_reason)
            # every language's missing dep reported with its manifest
            not_found_files = {f["source_file"] for f in by_reason["not-found"]}
            for fn in ("requirements.txt", "package.json", "go.mod", "Cargo.toml",
                       "pom.xml", "app.csproj", "conanfile.txt", "Gemfile",
                       "composer.json", "Package.swift", "pubspec.yaml"):
                self.assertIn(fn, not_found_files)
            young = by_reason["too-young"][0]
            self.assertIn("days old", young["message"])
            self.assertIn("14-day", young["message"])
            self.assertIn("down-js", {f["name"] for f in by_reason["registry-unreachable"]})
            checked_names = {c["name"] for c in r["checked"]}
            self.assertIn("exists-py", checked_names)
            self.assertIn("owner/exists-swift", checked_names)
        finally:
            td.cleanup()

    def test_user_journey_a_hallucinated_dependency(self):
        td, repo = write_repo({
            "pyproject.toml": '[project]\ndependencies = ["surely-fake-package-zzz"]\n',
        })
        try:
            fetcher = FakeFetcher(routes=dict([
                not_found_route("pypi", "surely-fake-package-zzz"),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            f = r["failures"][0]
            self.assertEqual(f["reason"], "not-found")
            self.assertEqual(f["source_file"], "pyproject.toml")
            self.assertEqual(f["line"], 2)
        finally:
            td.cleanup()

    def test_user_journey_b_registered_but_young(self):
        td, repo = write_repo({"requirements.txt": "youngdep\n"})
        try:
            fetcher = FakeFetcher(routes=dict([
                ok_route("pypi", "youngdep", iso_days_ago(3)),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            f = r["failures"][0]
            self.assertEqual(f["reason"], "too-young")
            self.assertIn("3 days old", f["message"])
            self.assertIn("14-day safety threshold", f["message"])
        finally:
            td.cleanup()

    def test_user_journey_c_ignore_file_fixes_it(self):
        td, repo = write_repo({
            ".slopsquat-ignore": "youngdep\n",
            "requirements.txt": "youngdep\n",
        })
        try:
            fetcher = FakeFetcher()  # zero requests expected
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(r["checked"], [])
            self.assertEqual(fetcher.requested_urls(), [])
        finally:
            td.cleanup()

    def test_user_journey_d_registry_down_actionable(self):
        td, repo = write_repo({"requirements.txt": "alpha\n"})
        try:
            def down(u, etag):
                raise ConnectionError("registry down")

            fetcher = FakeFetcher(default=down)
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            self.assertEqual(r["failures"][0]["reason"], "registry-unreachable")
            self.assertIn("unreachable", r["failures"][0]["message"])
        finally:
            td.cleanup()


