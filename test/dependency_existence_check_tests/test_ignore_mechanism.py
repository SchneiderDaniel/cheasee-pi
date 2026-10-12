"""Ignore-filter mechanisms.

Split from test/dependency-existence-check.test.py (issue #2005 Long File refactor).
"""

from ._common import *  # noqa: F401,F403
from ._common import _HERE, _SCRIPTS, _netloc  # noqa: F401

class IgnoreMechanismTests(unittest.TestCase):
    def setUp(self):
        self._orig = {n: c.interval for n, c in dec.REGISTRIES.items()}
        for c in dec.REGISTRIES.values():
            c.interval = 0

    def tearDown(self):
        for n, iv in self._orig.items():
            dec.REGISTRIES[n].interval = iv

    def test_ignore_file_parsing(self):
        td, repo = write_repo({".slopsquat-ignore": (
            "# private company packages\n"
            "internal-common\n"
            "python:requests\n"
            "internal-*\n"
            "\n"
        )})
        try:
            f = dec.IgnoreFilter(repo)
            self.assertTrue(f.ignored("python", "internal-common"))
            self.assertTrue(f.ignored("go", "internal-common"))
            self.assertTrue(f.ignored("python", "requests"))
            self.assertFalse(f.ignored("go", "requests"))
            self.assertTrue(f.ignored("rust", "internal-auth-lib"))
        finally:
            td.cleanup()

    def test_ignored_package_zero_requests(self):
        td, repo = write_repo({
            ".slopsquat-ignore": "alpha\n",
            "requirements.txt": "alpha\nbeta\n",
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "beta")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            names = {c["name"] for c in r["checked"]}
            self.assertEqual(names, {"beta"})
            self.assertEqual(len(fetcher.requested_urls()), 1)
        finally:
            td.cleanup()

    def test_lang_scoping(self):
        td, repo = write_repo({
            ".slopsquat-ignore": "python:requests\n",
            "requirements.txt": "requests\n",
            "Cargo.toml": '[dependencies]\nrequests = "1"\n',
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("crates", "requests")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            names = {(c["language"], c["name"]) for c in r["checked"]}
            self.assertEqual(names, {("rust", "requests")})
            self.assertEqual(len(fetcher.requested_urls()), 1)
            self.assertIn("crates.io", fetcher.requested_urls()[0])
        finally:
            td.cleanup()

    def test_inline_markers(self):
        td, repo = write_repo({
            "requirements.txt": "ignored-py # slopsquat-ignore\nchecked-py\n",
            "go.mod": (
                "module m\n\n"
                "require (\n"
                "\tignored-go v1.0.0 // slopsquat-ignore\n"
                "\tchecked-go v1.0.0\n"
                ")\n"),
            "pom.xml": (
                "<project><dependencies>\n"
                "<dependency><groupId>com.x</groupId><artifactId>ignored-java</artifactId>"
                "</dependency><!-- slopsquat-ignore -->\n"
                "<dependency><groupId>com.x</groupId><artifactId>checked-java</artifactId>"
                "</dependency>\n"
                "</dependencies></project>"),
        })
        try:
            routes = dict([
                ok_route("pypi", "checked-py"),
                ok_route("go", "checked-go"),
                ok_route("maven", "com.x:checked-java"),
                ok_route("maven-version", "com.x:checked-java"),
            ])
            fetcher = FakeFetcher(routes=routes)
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0, r["failures"])
            names = {c["name"] for c in r["checked"]}
            self.assertEqual(names, {"checked-py", "checked-go", "com.x:checked-java"})
            for u in fetcher.requested_urls():
                self.assertNotIn("ignored", u)
        finally:
            td.cleanup()

    def test_json_formats_have_no_inline_markers(self):
        # A trailing comment inside package.json is invalid JSON; the file must
        # be skipped, not silently treated as an ignore marker.
        td, repo = write_repo({
            "package.json": '{\n  "dependencies": {\n    "alpha": "1.0.0" // slopsquat-ignore\n  }\n}\n',
        })
        try:
            fetcher = FakeFetcher()
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)  # malformed manifest skipped, no crash
            self.assertEqual(r["checked"], [])
        finally:
            td.cleanup()
        # JSON formats rely on .slopsquat-ignore instead:
        td, repo = write_repo({
            ".slopsquat-ignore": "alpha\n",
            "package.json": json.dumps({"dependencies": {"alpha": "1.0.0", "beta": "1.0.0"}}),
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("npm", "beta")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual({c["name"] for c in r["checked"]}, {"beta"})
        finally:
            td.cleanup()

    def test_ignore_file_only_at_root(self):
        td, repo = write_repo({
            "sub/.slopsquat-ignore": "alpha\n",
            "requirements.txt": "alpha\n",
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)  # alpha still checked (nested ignore not consulted)
            self.assertEqual(len(r["checked"]), 1)
        finally:
            td.cleanup()

    def test_inline_marker_dedupe_semantics(self):
        # Same name in two manifests, one marked -> still checked once.
        td, repo = write_repo({
            "requirements.txt": "alpha # slopsquat-ignore\n",
            "pyproject.toml": '[project]\ndependencies = ["alpha>=1"]\n',
        })
        try:
            fetcher = FakeFetcher(routes=dict([ok_route("pypi", "alpha")]))
            code, out = run_main(["--root", str(repo), "--json"], fetcher)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertEqual(len(r["checked"]), 1)
            self.assertEqual(len(fetcher.requested_urls()), 1)
        finally:
            td.cleanup()


