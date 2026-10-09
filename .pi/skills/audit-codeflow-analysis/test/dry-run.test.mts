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
const VALIDATOR = resolve(
	REPO_ROOT,
	".pi/skills/audit-codeflow-analysis/scripts/validate-finding.sh",
);
const NODE = process.execPath;

// A real repo file every kept candidate can cite (resolution is against the
// real checkout, so the fixture must point at files that exist there).
const REAL_FILE = ".pi/skills/audit-codeflow-analysis/lib/report.ts";

// Five distinct real repo files, so a metric item can list a 5-file sample that
// resolves in the real checkout (selectCandidates drops facts whose every file is
// unresolved).
const REAL_FILES = [
	".pi/skills/audit-codeflow-analysis/lib/report.ts",
	".pi/skills/audit-codeflow-analysis/lib/fetch-report.ts",
	".pi/skills/audit-codeflow-analysis/scripts/dry-run.mts",
	".pi/skills/audit-codeflow-analysis/scripts/validate-finding.sh",
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
	rmSync(resolve(REPO_ROOT, "ignore/codeflow-findings"), { recursive: true, force: true });
});

const baseArgs = () => ["--report", fixture, "--json", join(dir, "absent.json")];

/** A `pi` stub that logs each invocation's argv to `log` and reports VALID. */
function writePiStub(bin: string, log: string): void {
	mkdirSync(bin, { recursive: true });
	const pi = join(bin, "pi");
	writeFileSync(
		pi,
		`#!/usr/bin/env bash\nprintf '===CALL===\\n' >> "${log}"\nprintf '%s\\n' "$@" >> "${log}"\necho 'VERDICT: VALID'\nexit 0\n`,
		"utf-8",
	);
	chmodSync(pi, 0o755);
}

const piLog = (log: string): string => (existsSync(log) ? readFileSync(log, "utf-8") : "");
const piCallCount = (log: string): number =>
	piLog(log).split("\n").filter((l) => l === "===CALL===").length;

describe("selectCandidates (pure)", () => {
	const fact = (kind: string, title: string, files: string[]): IssueFact => ({
		id: `${kind}:${title}`,
		kind,
		title,
		targets: files.map((path) => ({ kind: "file", path })),
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

	it("keeps a file-less layer-edge/symbol fact instead of treating it as unresolved", () => {
		const edge: IssueFact = {
			id: "architecture:0",
			kind: "architecture",
			title: "157 Architecture Violations",
			targets: [{ kind: "layer-edge", from: "utils", to: "ui" }],
			files: [],
		};
		const symbol: IssueFact = {
			id: "duplicate:0",
			kind: "duplicate",
			title: "execFn",
			targets: [{ kind: "symbol", name: "execFn" }],
			files: [],
		};
		const { candidates, suppressed } = selectCandidates([edge, symbol], resolveWith(new Set()));
		assert.deepStrictEqual(
			candidates.map((f) => f.title),
			["157 Architecture Violations", "execFn"],
		);
		assert.strictEqual(suppressed, 0);
	});
});

describe("slugifyFinding", () => {
	it("lowercases and hyphenates a title into the Step 3 file slug", () => {
		assert.strictEqual(slugifyFinding("HIGH: Hardcoded Secret"), "high-hardcoded-secret");
		assert.strictEqual(slugifyFinding("`on_open()`"), "on-open");
		assert.strictEqual(slugifyFinding("***"), "finding");
	});

	it("bounds an over-long slug and appends a deterministic full-title hash", () => {
		const title = `4 Similar Code Blocks with env with unresolved exec ${"word ".repeat(40)}`;
		const slug = slugifyFinding(title);
		assert.ok(Buffer.byteLength(slug, "utf-8") <= 89, `slug too long: ${slug.length}`);
		assert.match(slug, /^[a-z0-9-]+-[0-9a-f]{8}$/);
		assert.ok(/^[a-z0-9-]+$/.test(slug), `illegal characters in ${slug}`);
		assert.strictEqual(slugifyFinding(title), slug, "slug must be deterministic");
	});

	it("keeps two distinct long titles sharing a prefix collision-free", () => {
		const base = "4 Similar Code Blocks with env with unresolved exec ".padEnd(120, "x");
		assert.notStrictEqual(slugifyFinding(base + " one"), slugifyFinding(base + " two"));
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

	it("discloses a partial parse and the missing JSON export before exiting", () => {
		const partial = join(dir, "emit-partial.md");
		writeFileSync(partial, PARTIAL_ARCH_FIXTURE, "utf-8");
		const outDir = join(dir, "emit-partial-findings");
		const r = runDryRun([
			"--report",
			partial,
			"--json",
			join(dir, "absent.json"),
			"--emit-findings",
			outDir,
		]);
		assert.strictEqual(r.status, 0, r.stderr);
		// Emission must not look complete: the coverage shortfall and the
		// JSON-only categories are printed before the process exits.
		assert.match(r.stdout, /Architecture Issues: 2 item\(s\), 1 candidate\(s\), 1 unparsed/);
		assert.match(r.stdout, /Mystery Failure Mode/);
		assert.match(r.stdout, /JSON export unavailable/);
		assert.match(r.stdout, /partially unauditable/);
		assert.ok(!/UNREADABLE/.test(r.stdout), "a partial section must not be flagged unreadable");
	});

	it("emits every candidate for a long-title report with no ENAMETOOLONG", () => {
		const report = join(dir, "long-title.md");
		writeFileSync(
			report,
			[
				"# CodeFlow Analysis Report",
				"",
				"## Architecture Issues",
				"",
				`### 4 Similar Code Blocks with env with unresolved exec ${"word ".repeat(40)}`,
				`**Affected:** \`${REAL_FILE}\``,
				"",
			].join("\n"),
			"utf-8",
		);
		const outDir = join(dir, "long-title-findings");
		const r = runDryRun([
			"--report",
			report,
			"--json",
			join(dir, "absent.json"),
			"--emit-findings",
			outDir,
		]);
		assert.strictEqual(r.status, 0, r.stderr);
		const files = readdirSync(outDir);
		assert.strictEqual(files.length, 1, files.join(","));
		assert.match(files[0], /^\d{2}-[a-z0-9-]+-[0-9a-f]{8}\.md$/);
		const content = readFileSync(join(outDir, files[0]), "utf-8");
		assert.ok(
			content.includes("**Title:** 4 Similar Code Blocks with env with unresolved exec"),
			"the finding body must keep the untruncated title",
		);
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
				"No reference line.",
				"",
			].join("\n"),
			"utf-8",
		);
		const r = runDryRun(["--list", "--report", partial]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.match(r.stdout, /Architecture Issues: 3 item\(s\), 2 candidate\(s\), 1 unparsed/);
		assert.match(r.stdout, /Coupled Modules/);
		assert.ok(!/UNREADABLE/.test(r.stdout), "a partial section must not be flagged unreadable");
	});

	it("lists the unparsed title and discloses the missing JSON export for a partial section", () => {
		const partial = join(dir, "partial-arch.md");
		writeFileSync(partial, PARTIAL_ARCH_FIXTURE, "utf-8");
		const r = runDryRun(["--list", "--report", partial, "--json", join(dir, "absent.json")]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.match(r.stdout, /Architecture Issues: 2 item\(s\), 1 candidate\(s\), 1 unparsed/);
		assert.match(r.stdout, /Mystery Failure Mode/);
		assert.match(r.stdout, /JSON export unavailable/);
		assert.match(r.stdout, /partially unauditable/);
		assert.ok(!/UNREADABLE/.test(r.stdout));
	});
});

describe("dry-run triage routing (live 7-item architecture shape)", () => {
	let archFixture: string;
	beforeEach(() => {
		archFixture = join(dir, "arch.md");
		writeFileSync(archFixture, ARCH_FIXTURE, "utf-8");
	});

	it("emits one candidate per item, with targets and triage type", () => {
		const outDir = join(dir, "arch-findings");
		const r = runDryRun([
			"--report",
			archFixture,
			"--json",
			join(dir, "absent.json"),
			"--emit-findings",
			outDir,
		]);
		assert.strictEqual(r.status, 0, r.stderr);
		const files = readdirSync(outDir).sort();
		assert.strictEqual(files.length, 7, files.join(","));

		const read = (slug: string): string => {
			const name = files.find((f) => f.endsWith(`${slug}.md`));
			assert.ok(name, `no candidate for ${slug} in ${files.join(",")}`);
			return readFileSync(join(outDir, name), "utf-8");
		};

		const edge = read("157-architecture-violations");
		assert.match(edge, /utils → ui/);
		assert.match(edge, /\*\*Issue type:\*\* bug/);
		assert.match(read("6-duplicate-function-names"), /execFn/);

		const metric = read("75-large-files");
		assert.match(metric, /\*\*Issue type:\*\* chore/);
		assert.match(metric, /5 of 75/);
	});

	it("--list labels each fact and reports the routed count without UNREADABLE", () => {
		const r = runDryRun(["--list", "--report", archFixture, "--json", join(dir, "absent.json")]);
		assert.strictEqual(r.status, 0, r.stderr);
		assert.match(r.stdout, /75 Large Files \[chore\]/);
		assert.match(r.stdout, /157 Architecture Violations \[bug\]/);
		assert.match(r.stdout, /routed/i);
		assert.ok(!/UNREADABLE/.test(r.stdout));
		for (const title of [
			"21 Unused Functions",
			"75 Large Files",
			"196 Highly Coupled",
			"6 Duplicate Function Names",
			"4 Similar Code Blocks",
			"157 Architecture Violations",
			"276 High Complexity Files",
		]) {
			assert.ok(r.stdout.includes(title), `missing ${title}`);
		}
	});

	it("validate mode routes the metrics and spawns the validator once per bug-class item", () => {
		const bin = join(dir, "arch-bin");
		const log = join(dir, "arch-pi.log");
		writePiStub(bin, log);
		const r = runDryRun(
			["--report", archFixture, "--json", join(dir, "absent.json"), "--limit", "10"],
			{ PATH: `${bin}:${process.env.PATH ?? ""}` },
		);
		assert.strictEqual(r.status, 0, r.stderr);
		const calls = piCallCount(log);
		assert.strictEqual(calls, 4, `expected 4 validator runs, got ${calls}`);
		const all = piLog(log);
		assert.match(all, /157 Architecture Violations/);
		assert.match(all, /4 Similar Code Blocks/);
		assert.ok(!all.includes("75 Large Files"), "a metric must not be validated");
		assert.ok(!all.includes("196 Highly Coupled"), "a metric must not be validated");
		assert.ok(!all.includes("276 High Complexity Files"), "a metric must not be validated");
		for (const title of ["75 Large Files", "196 Highly Coupled", "276 High Complexity Files"]) {
			assert.match(r.stdout, new RegExp(`\\[chore\\] ${title}`));
		}
	});

	it("validate mode spawns no validator for a metric-only report", () => {
		const only = join(dir, "metric-only.md");
		writeFileSync(
			only,
			[
				"# CodeFlow Analysis Report",
				"",
				"## Architecture Issues",
				"",
				"### 75 Large Files",
				`**Affected:** ${REAL_FILES.map((f, i) => `\`${f} (${46 - i} fns)\``).join(", ")}`,
				"",
			].join("\n"),
			"utf-8",
		);
		const bin = join(dir, "metric-bin");
		const log = join(dir, "metric-pi.log");
		writePiStub(bin, log);
		const r = runDryRun(["--report", only, "--json", join(dir, "absent.json")], {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
		});
		assert.strictEqual(r.status, 0, r.stderr);
		assert.strictEqual(piCallCount(log), 0, "a metric must never reach a validator");
		assert.match(r.stdout, /routed/i);
	});

	it("operator journey surfaces every item and discloses the missing JSON export", () => {
		const outDir = join(dir, "journey-findings");
		const args = ["--report", archFixture, "--json", join(dir, "absent.json")];
		const emit = runDryRun([...args, "--emit-findings", outDir]);
		assert.strictEqual(emit.status, 0, emit.stderr);
		assert.strictEqual(readdirSync(outDir).length, 7);

		const list = runDryRun(["--list", ...args]);
		assert.strictEqual(list.status, 0, list.stderr);
		assert.match(list.stdout, /JSON export unavailable/);
		assert.match(list.stdout, /partially unauditable/);

		const bin = join(dir, "journey-bin");
		const log = join(dir, "journey-pi.log");
		writePiStub(bin, log);
		const validate = runDryRun([...args, "--limit", "10"], {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
		});
		assert.strictEqual(validate.status, 0, validate.stderr);
		assert.match(validate.stdout, /JSON export unavailable/);
		assert.match(validate.stdout, /partially unauditable/);
		assert.strictEqual(piCallCount(log), 4);
	});
});

describe("dry-run validation-mode disclosure", () => {
	it("discloses a partially parsed section and lists its unparsed title", () => {
		const partial = join(dir, "partial-validate.md");
		writeFileSync(partial, PARTIAL_ARCH_FIXTURE, "utf-8");
		const bin = join(dir, "partial-bin");
		const log = join(dir, "partial-pi.log");
		writePiStub(bin, log);
		const r = runDryRun(["--report", partial, "--json", join(dir, "absent.json")], {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
		});
		assert.strictEqual(r.status, 0, r.stderr);
		// Normal validation mode must surface the coverage shortfall, not just --list.
		assert.match(r.stdout, /Architecture Issues: 2 item\(s\), 1 candidate\(s\), 1 unparsed/);
		assert.match(r.stdout, /Mystery Failure Mode/);
		assert.match(r.stdout, /partially unauditable/);
		assert.ok(!/UNREADABLE/.test(r.stdout), "a partial section must not be flagged unreadable");
	});
});

describe("documented emit → validate loop", () => {
	it("validates only issueType: bug findings from the emitted candidate set", () => {
		const archFixture = join(dir, "documented-arch.md");
		writeFileSync(archFixture, ARCH_FIXTURE, "utf-8");
		const outDir = join(dir, "documented-findings");
		const emit = runDryRun([
			"--report",
			archFixture,
			"--json",
			join(dir, "absent.json"),
			"--emit-findings",
			outDir,
		]);
		assert.strictEqual(emit.status, 0, emit.stderr);
		// --emit-findings writes every candidate, triage-tagged.
		assert.strictEqual(readdirSync(outDir).length, 7);

		const bin = join(dir, "documented-bin");
		const log = join(dir, "documented-pi.log");
		writePiStub(bin, log);
		// The exact Step 3 loop from SKILL.md: skip non-bug candidates.
		const loop = [
			`for f in ${outDir}/*.md; do`,
			`  grep -q '^\\*\\*Issue type:\\*\\* bug$' "$f" || continue`,
			`  bash "${VALIDATOR}" "$f" "${REPO_ROOT}" > "\${f%.md}.verdict" &`,
			`  while [ "$(jobs -rp | wc -l)" -ge 4 ]; do wait -n; done`,
			`done`,
			`wait`,
		].join("\n");
		const r = spawnSync("bash", ["-c", loop], {
			cwd: REPO_ROOT,
			encoding: "utf-8",
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
		});
		assert.strictEqual(r.status, 0, r.stderr);
		assert.strictEqual(piCallCount(log), 4, "only the 4 bug-class items may be validated");
		const all = piLog(log);
		assert.ok(!all.includes("75 Large Files"), "a metric must never reach a validator");
		assert.ok(!all.includes("196 Highly Coupled"), "a metric must never reach a validator");
		assert.ok(!all.includes("276 High Complexity Files"), "a metric must never reach a validator");
	});
});

