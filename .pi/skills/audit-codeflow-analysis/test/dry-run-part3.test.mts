/**
 * `dry-run` contracts for derived facts (issue #2030).
 *
 * Split out of `dry-run.test.mts`, which #2035 keeps at or under the 500-segment
 * ceiling. A `suggestions[]` card is listed so the operator sees the signal, and
 * never drafted: filing it standalone produced file-less issues whose count
 * contradicted the export that produced them.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/dry-run-part3.test.mts
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const CLI = resolve(REPO_ROOT, ".pi/skills/audit-codeflow-analysis/scripts/dry-run.mts");

// A real repo file every kept candidate can cite (resolution runs against the
// checkout, so the fixture must point at a file that exists there).
const REAL_FILE = ".pi/skills/audit-codeflow-analysis/lib/report.ts";

// The markdown source must exist and parse; the derived facts come from the JSON.
const MARKDOWN =
	"# CodeFlow Analysis Report\n\n## Security Issues\n\n### HIGH: Hardcoded Secret\n- **File:** `.pi/skills/audit-codeflow-analysis/lib/report.ts`\n";

const runDryRun = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
	const r = spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

let dir: string;
let fixture: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codeflow-dryrun-derived-"));
	fixture = join(dir, "report.md");
	writeFileSync(fixture, MARKDOWN, "utf-8");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(resolve(REPO_ROOT, "ignore/codeflow-findings"), { recursive: true, force: true });
});

// Issue #2030. A `suggestions[]` card is derived from the findings underneath it,
// so it is listed (the operator sees it) but never filed (it has no code of its
// own to fix). Filing it standalone produced file-less issues whose counts
// contradicted the export.
describe("dry-run — derived facts are listed, never filed (issue #2030, Phase 6)", () => {
	function suggestionsJson(withDerived = true): string {
		const file = join(dir, `derived-${withDerived}.json`);
		writeFileSync(
			file,
			JSON.stringify({
				architectureIssues: [{ title: "81 Large Files", affectedFiles: [REAL_FILE] }],
				patterns: [{ name: "God Object", isAntiPattern: true, files: [REAL_FILE] }],
				securityIssues: [{ severity: "high", title: "Hardcoded Secret", path: REAL_FILE }],
				...(withDerived
					? { suggestions: [{ title: "Fix Security Issues", desc: "9 high-severity issues" }] }
					: {}),
			}),
			"utf-8",
		);
		return file;
	}

	it("names link-derived after offer-optional in the dispositions line", () => {
		const json = join(dir, "order.json");
		writeFileSync(
			json,
			JSON.stringify({
				architectureIssues: [{ title: "6 Duplicate Function Names", affectedFiles: [REAL_FILE] }],
				patterns: [
					{ name: "God Object", isAntiPattern: true, files: [REAL_FILE] },
					{ name: "Singleton", files: [REAL_FILE] },
				],
				suggestions: [{ title: "Remove Dead Code", desc: "24 unused functions" }],
			}),
			"utf-8",
		);
		const r = runDryRun(["--list", "--report", fixture, "--json", json]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.match(
			r.stdout,
			/dispositions: file-bug 1, file-refactor 1, offer-optional 1, link-derived 1/,
		);
		assert.match(r.stdout, /\[derived\]/, "a derived fact must be listed, not dropped silently");
	});

	it("writes a derived fact its own finding file, naming the missing code target", () => {
		const outDir = join(dir, "derived-findings");
		const r = runDryRun([
			"--report",
			fixture,
			"--json",
			suggestionsJson(),
			"--emit-findings",
			outDir,
		]);
		assert.strictEqual(r.status, 0, r.stderr);

		const files = readdirSync(outDir);
		const name = files.find((f) => f.endsWith("fix-security-issues.md"));
		assert.ok(name, `no finding file for the derived fact in ${files.join(",")}`);
		const content = readFileSync(join(outDir, name), "utf-8");
		assert.match(content, /\*\*Disposition:\*\* link-derived/);
		assert.match(content, /\*\*Issue type:\*\* derived/);
		assert.ok(content.includes("(no file — derived signal)"), content);
		assert.match(r.stdout, /file-bug 1/);
		assert.match(r.stdout, /link-derived 1/);
	});

	it("drafts no issue for a derived fact and says how many it skipped", () => {
		const outDir = join(dir, "derived-drafts");
		const r = runDryRun([
			"--report",
			fixture,
			"--json",
			suggestionsJson(),
			"--emit-issues",
			outDir,
		]);
		assert.strictEqual(r.status, 0, r.stderr);

		const files = readdirSync(outDir);
		assert.ok(
			!files.some((f) => f.includes("fix-security-issues")),
			`no draft may be derived-only: ${files.join(",")}`,
		);
		const manifest = readFileSync(join(outDir, "MANIFEST.txt"), "utf-8");
		assert.ok(!manifest.includes("Fix Security Issues"), manifest);
		assert.match(r.stdout, /1 derived fact\(s\) listed, not filed/);
		assert.match(r.stdout, /dispositions: .*link-derived 1/);
	});

	it("drafts no derived fact in the default preview and counts only what it would file", () => {
		const r = runDryRun(["--report", fixture, "--json", suggestionsJson()]);
		assert.strictEqual(r.status, 0, r.stderr);
		// The preview is what the operator takes to be the filing set: a derived
		// card must not appear there at all, only its skipped count.
		assert.doesNotMatch(r.stdout, /Fix Security Issues/);
		assert.doesNotMatch(r.stdout, /\[1\/4\]/);
		assert.match(r.stdout, /Would file 3 issue\(s\); printing the first 3\./);
		assert.match(r.stdout, /1 derived fact\(s\) listed, not filed\./);
		assert.match(r.stdout, /Summary: 4 candidate\(s\) — would file 3 issue\(s\)/);
		assert.doesNotMatch(r.stdout, /\(none\)/, "a file-less derived fact must not be drafted");
	});

	it("says nothing about derived facts when the report has none", () => {
		const outDir = join(dir, "no-derived");
		const r = runDryRun([
			"--report",
			fixture,
			"--json",
			suggestionsJson(false),
			"--emit-issues",
			outDir,
		]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.doesNotMatch(r.stdout, /derived fact\(s\) listed/);
		assert.doesNotMatch(r.stdout, /link-derived/);
	});

	it("still fails closed on a stale destination when derived facts are present", () => {
		const outDir = join(dir, "derived-stale");
		mkdirSync(outDir, { recursive: true });
		writeFileSync(join(outDir, "01-old.md"), "old", "utf-8");
		const r = runDryRun([
			"--report",
			fixture,
			"--json",
			suggestionsJson(),
			"--emit-issues",
			outDir,
		]);
		assert.strictEqual(r.status, 2, r.stderr);
		assert.match(r.stderr, /already contains 1 stale file/);
		assert.strictEqual(readFileSync(join(outDir, "01-old.md"), "utf-8"), "old");
	});
});
