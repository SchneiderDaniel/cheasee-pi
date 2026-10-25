/**
 * Tests for .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts —
 * `--emit-findings` extraction mode and coverage reporting.
 *
 * The CLI is spawned as a subprocess so emit mode (which must exit 0 without
 * ever spawning a subagent) and the process-exit directory survival are tested
 * for real. The `slugifyFinding` helper is imported in-process.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/dry-run.test.mts
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const CLI = resolve(REPO_ROOT, ".pi/skills/audit-codeflow-analysis/scripts/dry-run.mts");
const NODE = process.execPath;

// A real repo file every kept candidate can cite (resolution is against the
// real checkout, so the fixture must point at files that exist there).
const REAL_FILE = ".pi/skills/audit-codeflow-analysis/lib/report.ts";

// Five distinct real repo files, so a metric item can list a 5-file sample that
// resolves in the real checkout.
const REAL_FILES = [
	".pi/skills/audit-codeflow-analysis/lib/report.ts",
	".pi/skills/audit-codeflow-analysis/lib/fetch-report.ts",
	".pi/skills/audit-codeflow-analysis/lib/codeflow-run.ts",
	".pi/skills/audit-codeflow-analysis/scripts/dry-run.mts",
	".pi/skills/audit-codeflow-analysis/SKILL.md",
];

// The live 7-item `## Architecture Issues` shape: three derived metrics (chore)
// and four edge/duplicate/symbol findings (bug).
const ARCH_FIXTURE = [
	"# CodeFlow Analysis Report",
	"",
	"## Architecture Issues",
	"",
	"### 21 Unused Functions",
	"**Affected:** `defaultFetch`, `defaultWriteFile`, `opened`, `stable_elapsed`, `transport_closed`",
	"",
	"### 75 Large Files",
	`**Affected:** ${REAL_FILES.map((f, i) => `\`${f} (${46 - i} fns)\``).join(", ")}`,
	"",
	"### 196 Highly Coupled",
	`**Affected:** \`${REAL_FILES[0]} (72 imports)\`, \`${REAL_FILES[1]} (41 imports)\``,
	"",
	"### 6 Duplicate Function Names",
	"**Affected:** `execFn (3 files)`, `info (4 files)`",
	"",
	"### 4 Similar Code Blocks",
	"**Affected:** `readSettingsCodeflowPort, readSettingsUIPort`",
	"",
	"### 157 Architecture Violations",
	"**Affected:** `utils → ui`, `utils → ui`",
	"",
	"### 276 High Complexity Files",
	`**Affected:** \`${REAL_FILES[0]} (233)\`, \`${REAL_FILES[1]} (206)\``,
	"",
].join("\n");

// A partial architecture section: one parseable edge item, one ref-less item.
const PARTIAL_ARCH_FIXTURE = [
	"# CodeFlow Analysis Report",
	"",
	"## Architecture Issues",
	"",
	"### 157 Architecture Violations",
	"**Affected:** `utils → ui`",
	"",
	"### Mystery Failure Mode",
	"prose only, no reference line",
	"",
].join("\n");

const FIXTURE = [
	"# CodeFlow Analysis Report",
	"",
	"## Security Issues",
	"",
	"### HIGH: Hardcoded Secret",
	`- **File:** \`${REAL_FILE}\``,
	"",
	"### HIGH: SQL Injection Risk",
	`- **File:** \`${REAL_FILE}\``,
	"",
	"### HIGH: Shell Command Execution",
	"- **File:** `.pi/skills/audit-codeflow-analysis/scripts/dry-run.mts`",
	"",
	"### MEDIUM: Command Execution",
	"- **File:** `.pi/skills/audit-codeflow-analysis/lib/codeflow-run.ts`",
	"",
	"### HIGH: Function Constructor",
	"- **File:** `.pi/skills/audit-codeflow-analysis/lib/fetch-report.ts`",
	"",
	"### HIGH: Path Traversal",
	"- **File:** `.pi/skills/audit-codeflow-analysis/SKILL.md`",
	"",
	"### LOW: Code Comments",
	`- **File:** \`${REAL_FILE}\``,
	"",
	"## Unused Functions (1)",
	"",
	"### `ghostFn()`",
	"- **File:** `does/not/exist.ts`",
	"",
].join("\n");

interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runDryRun(args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
	const r = spawnSync(NODE, ["--experimental-strip-types", CLI, ...args], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
		env: { ...process.env, ...env },
	});
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let dir: string;
let fixture: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codeflow-dryrun-"));
	fixture = join(dir, "report.md");
	writeFileSync(fixture, FIXTURE, "utf-8");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(resolve(REPO_ROOT, "ignore/codeflow-findings"), { recursive: true, force: true });
});

const baseArgs = () => ["--report", fixture, "--json", join(dir, "absent.json")];

// Split from dry-run.test.mts (issue #2035 Long File refactor).
describe("dry-run --emit-issues", () => {
	it("writes one draft per subject, with title, signal, timestamp and isolation", () => {
		const json = join(dir, "drafts.json");
		writeFileSync(
			json,
			JSON.stringify({
				analyzedAt: "2026-10-12T11:36:08.312Z",
				securityIssues: [
					{
						severity: "high",
						title: "Hardcoded Secret",
						description: "never hardcode tokens",
						path: REAL_FILE,
					},
					{ severity: "high", title: "Hardcoded Secret", path: REAL_FILES[1] },
				],
				unusedFunctions: [{ name: "ghostFn", file: REAL_FILE }],
			}),
			"utf-8",
		);
		const outDir = join(dir, "drafts");
		const r = runDryRun(["--report", fixture, "--json", json, "--emit-issues", outDir]);
		assert.strictEqual(r.status, 0, r.stderr);

		const files = readdirSync(outDir).sort();
		const bodies = files.filter((f) => f.endsWith(".md"));
		const titles = files.filter((f) => f.endsWith(".title"));
		assert.strictEqual(bodies.length, 2, files.join(","));
		assert.strictEqual(titles.length, 2, files.join(","));
		assert.ok(files.includes("MANIFEST.txt"), files.join(","));

		const secretTitle = titles.find((t) => t.includes("hardcoded"));
		assert.ok(secretTitle, files.join(","));
		const secretBody = readFileSync(join(outDir, secretTitle.replace(/\.title$/, ".md")), "utf-8");
		assert.match(readFileSync(join(outDir, secretTitle), "utf-8"), /^\[Bug\] /);
		for (const want of [
			"`2026-10-12T11:36:08.312Z`",
			`\`${REAL_FILE}\``,
			`\`${REAL_FILES[1]}\``,
			"Best-effort isolation only",
			"Shared files:",
			"never hardcode tokens",
			"false positive",
		]) {
			assert.ok(secretBody.includes(want), `draft missing ${want}`);
		}
		const manifest = readFileSync(join(outDir, "MANIFEST.txt"), "utf-8");
		assert.match(manifest, /\[Bug\] HIGH: Hardcoded Secret/);
		assert.match(manifest, /files=2/);
		assert.match(r.stdout, /2 proposed issue\(s\) written/);
		assert.match(r.stdout, /No issues created/);
	});

	it("--by group merges facts that share a file into one draft", () => {
		const json = join(dir, "drafts-group.json");
		writeFileSync(
			json,
			JSON.stringify({
				securityIssues: [{ severity: "high", title: "Hardcoded Secret", path: REAL_FILE }],
				unusedFunctions: [{ name: "ghostFn", file: REAL_FILE }],
			}),
			"utf-8",
		);
		const outDir = join(dir, "drafts-group");
		const r = runDryRun([
			"--report",
			fixture,
			"--json",
			json,
			"--emit-issues",
			outDir,
			"--by",
			"group",
		]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.strictEqual(readdirSync(outDir).filter((f) => f.endsWith(".md")).length, 1);
	});

	it("falls back to the markdown **Analyzed:** line when the JSON export is absent", () => {
		const report = join(dir, "analyzed.md");
		writeFileSync(
			report,
			[
				"# CodeFlow Analysis Report",
				"**Analyzed:** 12.10.2026, 13:36:10",
				"",
				"## Security Issues",
				"",
				"### HIGH: Hardcoded Secret",
				`- **File:** \`${REAL_FILE}\``,
				"- **Description:** tokens must come from env, not source",
				"",
			].join("\n"),
			"utf-8",
		);
		const outDir = join(dir, "analyzed-drafts");
		const r = runDryRun([
			"--report",
			report,
			"--json",
			join(dir, "absent.json"),
			"--emit-issues",
			outDir,
		]);
		assert.strictEqual(r.status, 0, r.stderr);
		const body = readFileSync(
			join(outDir, readdirSync(outDir).find((f) => f.endsWith(".md")) as string),
			"utf-8",
		);
		assert.ok(body.includes("`12.10.2026, 13:36:10`"), body);
		assert.ok(body.includes("tokens must come from env, not source"), body);
	});

	it("fails closed instead of mixing a rerun with stale drafts", () => {
		const outDir = join(dir, "stale-drafts");
		mkdirSync(outDir, { recursive: true });
		writeFileSync(join(outDir, "01-old.md"), "old", "utf-8");
		const r = runDryRun([...baseArgs(), "--emit-issues", outDir]);
		assert.strictEqual(r.status, 2, r.stderr);
		assert.match(r.stderr, /already contains 1 stale file/);
		assert.strictEqual(readFileSync(join(outDir, "01-old.md"), "utf-8"), "old");
	});
});

describe("dry-run disposition routing (issue #1992)", () => {
	it("names each nonzero disposition in the --list summary", () => {
		const archFixture = join(dir, "disp-arch.md");
		writeFileSync(archFixture, ARCH_FIXTURE, "utf-8");
		const r = runDryRun(["--list", "--report", archFixture, "--json", join(dir, "absent.json")]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.match(r.stdout, /file-bug \d+/);
		assert.match(r.stdout, /file-refactor \d+/);
	});

	it("writes one candidate for every metric/anti-pattern and pattern, with its disposition", () => {
		const json = join(dir, "dispositions.json");
		writeFileSync(
			json,
			JSON.stringify({
				architectureIssues: [
					{ title: "81 Large Files", affectedFiles: [REAL_FILE] },
					{ title: "6 Duplicate Function Names", affectedFiles: [REAL_FILE] },
				],
				patterns: [
					{ name: "God Object", isAntiPattern: true, files: [REAL_FILE] },
					{ name: "Singleton", files: [REAL_FILE] },
				],
			}),
			"utf-8",
		);
		const outDir = join(dir, "dispositions-findings");
		const r = runDryRun(["--report", fixture, "--json", json, "--emit-findings", outDir]);
		assert.strictEqual(r.status, 0, r.stderr);
		const files = readdirSync(outDir);
		assert.strictEqual(files.length, 4, files.join(","));
		const content = (slug: string): string => {
			const name = files.find((f) => f.endsWith(`${slug}.md`));
			assert.ok(name, `no candidate for ${slug} in ${files.join(",")}`);
			return readFileSync(join(outDir, name), "utf-8");
		};
		assert.match(content("81-large-files"), /\*\*Disposition:\*\* file-refactor/);
		assert.match(content("god-object"), /\*\*Disposition:\*\* file-refactor/);
		assert.match(content("singleton"), /\*\*Disposition:\*\* offer-optional/);
		assert.match(content("singleton"), /\*\*Issue type:\*\* informational/);
		assert.match(content("6-duplicate-function-names"), /\*\*Disposition:\*\* file-bug/);
		assert.match(r.stdout, /file-refactor 2/);
		assert.match(r.stdout, /offer-optional 1/);
		assert.match(r.stdout, /file-bug 1/);
	});

	it("resolves architecture items from the nested files[].file shape", () => {
		const json = join(dir, "nested.json");
		writeFileSync(
			json,
			JSON.stringify({
				architectureIssues: [
					{
						title: "6 Duplicate Function Names",
						affectedFiles: ["execFn (3 files)", "info (4 files)"],
						affectedItems: [{ files: [{ file: REAL_FILE }] }],
					},
				],
			}),
			"utf-8",
		);
		const r = runDryRun(["--list", "--report", fixture, "--json", json]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.match(r.stdout, /6 Duplicate Function Names/);
		assert.ok(!/\(unresolved\)/.test(r.stdout), "a nested path must resolve, not be suppressed");
	});

	it("--self-check covers the usability predicate and disposition mapping", () => {
		const r = runDryRun(["--self-check"]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.match(r.stdout, /self-check OK/);
	});
});
