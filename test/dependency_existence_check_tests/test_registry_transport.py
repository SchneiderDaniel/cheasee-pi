"""Registry clients and the fetch/cache transport — URL/maven/normalization/404 family.

Split from test/dependency-existence-check.test.py (issue #2005 Long File refactor).
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401
from ._bases import RegistryIntervalBase  # noqa: E402

class RegistryAndTransportTests(RegistryIntervalBase):
    def test_registry_url_construction(self):
        fixtures = [
            ("pypi", {"requirements.txt": "requests\n"}, "requests"),
            ("npm", {"package.json": json.dumps({"dependencies": {"@scope/name": "1.0.0"}})},
             "@scope/name"),
            ("go", {"go.mod": "module m\n\nrequire github.com/Azure/foo v1.0.0\n"},
             "github.com/Azure/foo"),
            ("crates", {"Cargo.toml": '[dependencies]\nserde = "1"\n'}, "serde"),
            ("nuget", {"app.csproj": '<PackageReference Include="Newtonsoft.Json" />'},
             "Newtonsoft.Json"),
            ("vcpkg", {"vcpkg.json": json.dumps({"dependencies": ["zlib"]})}, "zlib"),
            ("conan", {"conanfile.txt": "[requires]\nopenssl/3.0.0\n"}, "openssl"),
            ("rubygems", {"Gemfile": 'gem "rails"\n'}, "rails"),
            ("packagist", {"composer.json": json.dumps({"require": {"vendor/pkg": "^1.0"}})},
             "vendor/pkg"),
            ("swift", {"Package.swift": '.package(url: "https://github.com/owner/repo.git", from: "1.0.0")\n'},
             "owner/repo"),
            ("pub", {"pubspec.yaml": "dependencies:\n  http: ^1.0.0\n"}, "http"),
        ]
        for reg, files, dep_name in fixtures:
            td, repo = write_repo(files)
            try:
                fetcher = FakeFetcher(routes=dict([ok_route(reg, dep_name)]))
                code, out = run_main(["--root", str(repo), "--json"], fetcher)
                r = json.loads(out)
                self.assertEqual(code, 0, f"{reg}: {r['failures']}")
                self.assertEqual(fetcher.requested_urls(),
                                 [url_for(reg, dep_name)], reg)
            finally:
                td.cleanup()

    def test_maven_two_requests(self):
        td, repo = write_repo({
            "pom.xml": ("<project><dependencies><dependency>"
                        "<groupId>com.example</groupId><artifactId>widget</artifactId>"
                        "</dependency></dependencies></project>"),
        })
        try:
            name = "com.example:widget"
            fetcher = FakeFetcher(routes=dict([
                ok_route("maven", name), ok_route("maven-version", name),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0, r["failures"])
            urls = fetcher.requested_urls()
            self.assertEqual(len(urls), 2)
            self.assertEqual(urls[0], url_for("maven", name))
            self.assertEqual(urls[1], url_for("maven-version", name))
            self.assertIsNotNone(r["checked"][0]["age_days"])
        finally:
            td.cleanup()

    def test_pypi_name_normalization(self):
        td, repo = write_repo({"requirements.txt": "Foo_Bar\n"})
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "foo-bar")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            self.assertEqual(code, 0)
            self.assertEqual(fetcher.requested_urls(),
                             ["https://pypi.org/pypi/foo-bar/json"])
        finally:
            td.cleanup()

    def test_404_is_not_found(self):
        td, repo = write_repo({"requirements.txt": "does-not-exist-xyz\n"})
        try:
            fetcher = FakeFetcher(routes=dict([
                not_found_route("pypi", "does-not-exist-xyz"),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            f = r["failures"][0]
            self.assertEqual(f["reason"], "not-found")
            self.assertEqual(f["source_file"], "requirements.txt")
            self.assertEqual(f["line"], 1)
        finally:
            td.cleanup()
