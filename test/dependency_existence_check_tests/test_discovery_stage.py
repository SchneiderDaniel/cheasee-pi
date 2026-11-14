"""Discovery stage (`discovery.collect_dependencies`) contract.

Issue #2103 (Highly Coupled): the walk, the gitignore/ignore filtering, the
candidate-filename pre-filter and the adapter extraction are one stage now, so
their contract is pinned here instead of only through the CLI report.

Relativization of `source_file` deliberately stays in `core` — this stage hands
back absolute paths.
"""

from unittest import mock

from ._common import *  # noqa: F401,F403
from ._common import _SCRIPTS  # noqa: F401

_PKG_DIR = _SCRIPTS / "dependency_existence_check"


def _collect(root):
    """Run the discovery stage exactly as `core.run_check` does."""
    return dec.discovery.collect_dependencies(
        root, dec.GitignoreMatcher(root), dec.IgnoreFilter(root))


class DiscoveryStageTests(unittest.TestCase):
    def test_one_dependency_per_declared_package(self):
        td, repo = write_repo({
            "requirements.txt": "alpha\nbeta\n",
            "package.json": json.dumps({"dependencies": {"gamma": "1.0.0"}}),
            "go.mod": ("module example.test/x\n\ngo 1.21\n\n"
                       "require github.com/omega/lib v1.2.3\n"),
        })
        try:
            deps = _collect(repo)
            self.assertEqual(sorted((d.language, d.name) for d in deps), [
                ("go", "github.com/omega/lib"),
                ("javascript", "gamma"),
                ("python", "alpha"),
                ("python", "beta"),
            ])
            for dep in deps:
                src = Path(dep.source_file)
                self.assertTrue(src.is_absolute(), dep.source_file)
                self.assertIn(str(repo), str(src))
        finally:
            td.cleanup()

    def test_gitignored_and_always_skipped_dirs_filtered(self):
        td, repo = write_repo({
            ".gitignore": "vendored/\n!.git/**\n!node_modules/**\n",
            "vendored/package.json": json.dumps(
                {"dependencies": {"vendored-js": "1.0.0"}}),
            ".git/package.json": json.dumps(
                {"dependencies": {"git-js": "1.0.0"}}),
            "node_modules/evil/package.json": json.dumps(
                {"dependencies": {"nm-js": "1.0.0"}}),
            "package.json": json.dumps({"dependencies": {"alpha": "1.0.0"}}),
        })
        try:
            self.assertEqual({d.name for d in _collect(repo)}, {"alpha"})
        finally:
            td.cleanup()

    def test_non_manifest_lookalike_never_read(self):
        # requirements.txt content sits in a file no adapter claims: the
        # candidate-filename pre-filter keeps it unread.
        td, repo = write_repo({
            "notes.txt": "alpha\nbeta\n",
            "requirements.txt": "gamma\n",
        })
        try:
            self.assertEqual({d.name for d in _collect(repo)}, {"gamma"})
        finally:
            td.cleanup()

    def test_first_matching_adapter_wins_without_duplicates(self):
        class _Stub(dec.Adapter):
            patterns = ("deps.txt",)

            def __init__(self, language, tag):
                self.language = language
                self.tag = tag

            def extract(self, text, path=None):
                return [self._dep(self.tag, None, 0, False, path)]

        first = _Stub("python", "first-pkg")
        second = _Stub("javascript", "second-pkg")
        td, repo = write_repo({"deps.txt": "irrelevant\n"})
        try:
            with mock.patch.object(dec.discovery, "ADAPTERS", [first, second]):
                deps = _collect(repo)
            self.assertEqual([(d.language, d.name) for d in deps],
                             [("python", "first-pkg")])
        finally:
            td.cleanup()

    def test_repeated_calls_are_identical(self):
        td, repo = write_repo({
            "requirements.txt": "alpha\nbeta\n",
            "package.json": json.dumps({"dependencies": {"gamma": "1.0.0"}}),
            "a/b/go.mod": "module example.test/y\n\nrequire github.com/zeta/lib v0.1.0\n",
        })
        try:
            first = [(d.name, d.version, d.source_file) for d in _collect(repo)]
            second = [(d.name, d.version, d.source_file) for d in _collect(repo)]
            self.assertEqual(first, second)
            self.assertGreater(len(first), 1)
        finally:
            td.cleanup()

    def test_ignore_file_drops_matching_dependencies(self):
        td, repo = write_repo({
            ".slopsquat-ignore": "alpha\njavascript:internal-*\n",
            "requirements.txt": "alpha\nbeta\n",
            "package.json": json.dumps(
                {"dependencies": {"internal-tool": "1.0.0", "gamma": "1.0.0"}}),
        })
        try:
            self.assertEqual({d.name for d in _collect(repo)}, {"beta", "gamma"})
        finally:
            td.cleanup()


class DiscoveryStageBoundaryTests(unittest.TestCase):
    def test_stage_imports_neither_cli_nor_transport(self):
        src = (_PKG_DIR / "discovery.py").read_text(encoding="utf-8")
        for banned in ("from .cli import", "from .transport import",
                       "import cli", "import transport"):
            self.assertNotIn(banned, src)
