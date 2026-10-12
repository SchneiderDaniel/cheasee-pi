"""Registry clients and the fetch/cache transport — registry-client family.

Split from test/dependency-existence-check.test.py (issue #2005 Long File refactor).
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401
from ._bases import RegistryIntervalBase  # noqa: E402

class RegistryTransportRegistriesTests(RegistryIntervalBase):
    def test_packagist_missing_vendor_no_crash(self):
        td, repo = write_repo({"composer.json": json.dumps({"require": {"nope": "^1.0"}})})
        try:
            fetcher = FakeFetcher()
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 1)
            self.assertEqual(r["failures"][0]["reason"], "registry-unreachable")
        finally:
            td.cleanup()

    def test_nuget_case_insensitive_id(self):
        td, repo = write_repo({
            "app.csproj": '<PackageReference Include="Newtonsoft.Json" />',
        })
        try:
            fetcher = FakeFetcher(routes=dict([
                ok_route("nuget", "newtonsoft.json"),
            ]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            self.assertEqual(code, 0)
            self.assertEqual(fetcher.requested_urls(),
                             ["https://api.nuget.org/v3/registration5-semver1/newtonsoft.json/index.json"])
        finally:
            td.cleanup()
