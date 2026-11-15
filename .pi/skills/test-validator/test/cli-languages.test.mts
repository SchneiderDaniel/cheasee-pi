// Phase 8c — a completed audit is repository-wide, not node-only.
//
// The completion gate may only claim the whole repository once Go, Python, and
// shell tests are inventoried too, so these are end-to-end subprocess runs over
// a fixture repository that has all four kinds of test file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ghCalls, reportPath, runCli, withRepo } from "./support/cli-fixture.mts";

const GO_TEST = [
	"package demo",
	"",
	'import "testing"',
	"",
	"func TestAddsTotals(t *testing.T) {",
	"\tif add(1, 2) != 3 {",
	'\t\tt.Fatal("expected 3")',
	"\t}",
	"}",
	"",
].join("\n");

const PY_TEST = [
	"import unittest",
	"",
	"class TestCart(unittest.TestCase):",
	"    def test_total(self):",
	"        self.assertEqual(total(), 2)",
	"",
].join("\n");

const SH_TEST = ["#!/usr/bin/env bash", "set -euo pipefail", "test 1 -eq 1", ""].join("\n");

const RS_TEST = ["#[test]", "fn adds_totals() {", "\tassert_eq!(1 + 1, 2);", "}", ""].join("\n");

const MULTI_LANGUAGE_FILES = {
	"go.mod": "module example.test/demo\n",
	"pkg/add_test.go": GO_TEST,
	"test/test_cart.py": PY_TEST,
	"test/hygiene.test.sh": SH_TEST,
	"ui/src/lib.rs": RS_TEST,
};

describe("cli: repository-wide inventory", () => {
	it("names every language it audited on stderr", async () => {
		await withRepo({ files: MULTI_LANGUAGE_FILES }, async (repo) => {
			const result = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "good" });

			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stderr, /typescript: 2 in 1 file\(s\)/);
			assert.match(result.stderr, /go: 1 in 1 file\(s\)/);
			assert.match(result.stderr, /python: 1 in 1 file\(s\)/);
			assert.match(result.stderr, /shell: 1 in 1 file\(s\)/);
			assert.match(result.stderr, /rust: 1 in 1 file\(s\)/);
			assert.match(result.stdout, /counts: 6 judged \(6 GOOD, 0 BAD, 0 pending\)/);
		});
	});

	it("judges a Go, a Python, and a shell test, not only the node ones", async () => {
		await withRepo({ files: MULTI_LANGUAGE_FILES }, async (repo) => {
			const result = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "bad" });

			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /6 judged \(0 GOOD, 6 BAD, 0 pending\)/);

			const report = JSON.parse(readFileSync(reportPath(repo), "utf8"));
			assert.equal(report.counts.discovered, 6);
			const byLanguage = report.coverage.byLanguage;
			assert.equal(byLanguage.go.tests, 1);
			assert.equal(byLanguage.python.tests, 1);
			assert.equal(byLanguage.shell.tests, 1);
			assert.equal(byLanguage.rust.tests, 1);
			assert.equal(report.coverage.files, 5);

			const body = readFileSync(`${repo.ghLog}.body`, "utf8");
			for (const location of [
				"src/a.test.mts",
				"pkg/add_test.go",
				"test/test_cart.py",
				"test/hygiene.test.sh",
				"ui/src/lib.rs",
			]) {
				assert.ok(body.includes(location), `the issue must list ${location}`);
			}
			assert.match(body, /TestAddsTotals/);
			assert.match(body, /TestCart > test_total/);
			assert.match(body, /hygiene\.test\.sh/);
			assert.match(body, /adds_totals/);
			assert.match(body, /Coverage: 5 test file\(s\)/);

			const creates = ghCalls(repo).filter((argv) => argv[0] === "issue" && argv[1] === "create");
			assert.equal(creates.length, 1, "one issue for the whole repository");
		});
	});

	it("keeps a Go test-support file out of the completion gate", async () => {
		await withRepo(
			{
				files: {
					...MULTI_LANGUAGE_FILES,
					"pkg/helpers_test.go": "package demo\n\nfunc add(a, b int) int { return a + b }\n",
				},
			},
			async (repo) => {
				const result = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "good" });

				assert.equal(result.status, 0, result.stderr);
				assert.match(result.stderr, /go: 1 in 2 file\(s\), 1 excluded/);
				assert.match(result.stdout, /6 judged .*1 excluded/);

				const report = JSON.parse(readFileSync(reportPath(repo), "utf8"));
				assert.deepEqual(
					report.excluded.map((entry: { file: string; reason: string }) => [
						entry.file,
						entry.reason,
					]),
					[["pkg/helpers_test.go", "test-support-file"]],
				);
			},
		);
	});

	it("halts when a test file cannot be enumerated, naming it", async () => {
		await withRepo(
			{
				files: {
					...MULTI_LANGUAGE_FILES,
					"pkg/broken_test.go": "package demo\n\nfunc TestX(t *testing.T) {\n",
				},
			},
			async (repo) => {
				const result = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "good" });

				assert.notEqual(result.status, 0);
				assert.match(result.stderr, /pkg\/broken_test\.go/);
				assert.equal(
					ghCalls(repo).some((argv) => argv[0] === "issue" && argv[1] === "create"),
					false,
				);
			},
		);
	});
});
