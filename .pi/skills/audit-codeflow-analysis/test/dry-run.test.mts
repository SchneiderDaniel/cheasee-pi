/**
 * Tests for .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts —
 * `--emit-findings` extraction mode, known-noise pre-filtering and coverage
 * reporting.
 *
 * The CLI is spawned as a subprocess so emit mode (which must exit 0 without
 * ever spawning a subagent) and the process-exit directory survival are tested
 * for real. Pure helpers (`selectCandidates`) are imported in-process.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/dry-run.test.mts
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { selectCandidates, slugifyFinding, type FileResolution } from "../scripts/dry-run.mts";
import type { IssueFact } from "../lib/report.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const CLI = resolve(REPO_ROOT, ".pi/skills/audit-codeflow-analysis/scripts/dry-run.mts");
const NODE = process.execPath;

// A real repo file every kept candidate can cite (resolution is against the
// real checkout, so the fixture must point at files that exist there).
const REAL_FILE = ".pi/skills/audit-codeflow-analysis/lib/report.ts";

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
	"- **File:** `.pi/skills/audit-codeflow-analysis/scripts/validate-finding.sh`",
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
});

const baseArgs = () => ["--report", fixture, "--json", join(dir, "absent.json")];

describe("selectCandidates (pure)", () => {
	const fact = (kind: string, title: string, files: string[]): IssueFact => ({
		id: `${kind}:${title}`,
		kind,
		title,
		files,
	});
	const resolveWith =
		(unresolved: Set<string>) =>
		(file: string): FileResolution =>
			unresolved.has(file) ? { path: file, how: "unresolved" } : { path: file, how: "exact" };

	it("suppresses LOW style security noise and unresolved-only facts, keeping the rest", () => {
		const facts = [
			fact("security", "LOW: Code Comments", ["a.ts"]),
			fact("security", "LOW: Debug Statements", ["a.ts"]),
			fact("dead-code", "ghostFn()", ["ghost.ts"]),
			fact("security", "HIGH: Hardcoded Secret", ["a.ts"]),
			fact("suggestion", "Split module", []),
		];
		const { candidates, suppressed } = selectCandidates(facts, resolveWith(new Set(["ghost.ts"])));
		assert.deepStrictEqual(
			candidates.map((f) => f.title),
			["HIGH: Hardcoded Secret", "Split module"],
		);
		assert.strictEqual(suppressed, 3);
	});

	it("keeps a fact when at least one cited file resolves", () => {
		const facts = [fact("architecture", "Mixed", ["missing.ts", "a.ts"])];
		assert.strictEqual(
			selectCandidates(facts, resolveWith(new Set(["missing.ts"]))).candidates.length,
			1,
		);
	});
});

describe("slugifyFinding", () => {
	it("lowercases and hyphenates a title into the Step 3 file slug", () => {
		assert.strictEqual(slugifyFinding("HIGH: Hardcoded Secret"), "high-hardcoded-secret");
		assert.strictEqual(slugifyFinding("`on_open()`"), "on-open");
		assert.strictEqual(slugifyFinding("***"), "finding");
	});
});

describe("dry-run --emit-findings", () => {
	it("writes one NN-<slug>.md per candidate and exits 0 without a subagent", () => {
		const outDir = join(dir, "findings");
		// A `pi` that fails if it is ever spawned: emit mode must not validate.
		const bin = join(dir, "bin");
		mkdirSync(bin, { recursive: true });
		const pi = join(bin, "pi");
		writeFileSync(pi, "#!/usr/bin/env bash\nexit 1\n", "utf-8");
		chmodSync(pi, 0o755);

		const r = runDryRun([...baseArgs(), "--emit-findings", outDir], {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
		});
		assert.strictEqual(r.status, 0, r.stderr);

		const files = readdirSync(outDir).sort();
		// 6 resolvable security candidates; --limit default (5) must not truncate.
		assert.strictEqual(files.length, 6, `wrote ${JSON.stringify(files)}`);
		assert.ok(files.includes("01-high-hardcoded-secret.md"), files.join(","));
		assert.ok(
			files.every((f) => /^\d{2}-[a-z0-9-]+\.md$/.test(f)),
			files.join(","),
		);
		assert.ok(!files.some((f) => f.endsWith(".verdict")), "emit mode must not validate");

		// The directory survives process exit (no `finally` rmSync in emit mode).
		assert.ok(existsSync(outDir), "emitted directory must survive the run");

		const first = readFileSync(join(outDir, "01-high-hardcoded-secret.md"), "utf-8");
		for (const want of [
			"**Kind:** security",
			"**Title:** HIGH: Hardcoded Secret",
			"**Id:**",
			"**Section:**",
			REAL_FILE,
			"read the cited code and",
		]) {
			assert.ok(first.includes(want), `candidate file missing ${want}`);
		}
		assert.match(r.stdout, /\d+ candidate\(s\) written/);
	});

	it("reports the suppressed known-noise count instead of silently shrinking the set", () => {
		const outDir = join(dir, "counted");
		const r = runDryRun([...baseArgs(), "--emit-findings", outDir]);
		assert.strictEqual(r.status, 0, r.stderr);
		// LOW: Code Comments + the unresolved-only ghostFn.
		assert.match(r.stdout, /2 known-noise\/unresolved candidate\(s\) suppressed/);
	});

	it("exits 2 and creates no directory when the report is missing", () => {
		const outDir = join(dir, "never");
		const r = runDryRun(["--report", join(dir, "absent.md"), "--emit-findings", outDir]);
		assert.strictEqual(r.status, 2);
		assert.ok(!existsSync(outDir), "must not create the target directory on a missing report");
	});

	it("fails closed instead of mixing a rerun with stale findings", () => {
		const outDir = join(dir, "stale");
		mkdirSync(outDir, { recursive: true });
		const stale = join(outDir, "01-old-finding.md");
		writeFileSync(stale, "old", "utf-8");

		const r = runDryRun([...baseArgs(), "--emit-findings", outDir]);
		assert.strictEqual(r.status, 2, r.stderr);
		assert.match(r.stderr, /already contains 1 stale file/);
		assert.strictEqual(readFileSync(stale, "utf-8"), "old", "stale file must be untouched");
		assert.deepStrictEqual(readdirSync(outDir), ["01-old-finding.md"], "no candidates written");
	});
});

describe("operator journey: emit → validate → reconcile", () => {
	it("yields a complete candidate set and separates a retryable crash from a verdict-less run", () => {
		const outDir = join(dir, "journey-findings");
		const emit = runDryRun([...baseArgs(), "--emit-findings", outDir]);
		assert.strictEqual(emit.status, 0, emit.stderr);
		const files = readdirSync(outDir).sort();
		assert.ok(files.length > 5, `expected >5 candidates, got ${files.length}`);

		const bin = join(dir, "journey-bin");
		mkdirSync(bin, { recursive: true });
		const pi = join(bin, "pi");
		writeFileSync(
			pi,
			"#!/usr/bin/env bash\ncase \"${PI_STUB_MODE:-}\" in\n  crash) echo 'RangeError: Invalid string length' >&2; exit 1 ;;\n  neverdict) echo nothing; exit 0 ;;\n  invalid) echo 'VERDICT: INVALID'; exit 0 ;;\n  *) echo 'VERDICT: VALID'; exit 0 ;;\nesac\n",
			"utf-8",
		);
		chmodSync(pi, 0o755);
		const script = resolve(
			REPO_ROOT,
			".pi/skills/audit-codeflow-analysis/scripts/validate-finding.sh",
		);
		const validate = (file: string, mode: string) =>
			spawnSync("bash", [script, file, REPO_ROOT], {
				cwd: REPO_ROOT,
				encoding: "utf-8",
				env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PI_STUB_MODE: mode },
			});

		assert.strictEqual(validate(join(outDir, files[0]), "valid").status, 0);
		assert.strictEqual(validate(join(outDir, files[1]), "invalid").status, 1);
		assert.strictEqual(validate(join(outDir, files[2]), "neverdict").status, 3);
		const crash = validate(join(outDir, files[3]), "crash");
		assert.strictEqual(crash.status, 4);
		assert.match(crash.stderr, /RangeError/);
		// A crash is recovery, not answer-shopping: one retry is allowed.
		assert.strictEqual(validate(join(outDir, files[3]), "valid").status, 0);

		const list = runDryRun(["--list", "--report", fixture, "--json", join(dir, "absent.json")]);
		assert.strictEqual(list.status, 0, list.stderr);
		assert.ok(!/UNREADABLE/.test(list.stdout), "no section may be presented as unreadable");
	});
});

describe("dry-run --list coverage", () => {
	it("labels a partially parsed architecture section without calling it unreadable", () => {
		const partial = join(dir, "partial.md");
		writeFileSync(
			partial,
			[
				"# CodeFlow Analysis Report",
				"",
				"## Architecture Issues",
				"",
				"### 154 Architecture Violations",
				`**Affected:** \`utils → ui\``,
				"",
				"### 6 Duplicate Function Names",
				"**Affected:** `execFn (3 files)`",
				"",
				"### Coupled Modules",
				`**Affected:** \`${REAL_FILE}\``,
				"",
			].join("\n"),
			"utf-8",
		);
		const r = runDryRun(["--list", "--report", partial]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.match(r.stdout, /Architecture Issues: 3 item\(s\), 1 candidate\(s\), 2 unparsed/);
		assert.ok(!/UNREADABLE/.test(r.stdout), "a partial section must not be flagged unreadable");
	});
});
