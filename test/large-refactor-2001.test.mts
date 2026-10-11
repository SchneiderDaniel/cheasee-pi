// ─── Large-files refactor contract (issue #2001) ──────────────────
// CodeFlow's "Large Files" metric is `files.filter(f => f.functions.length > 15)`
// (index.html `godFiles`). The authoritative 63-file list lives in the
// CodeFlow report artifact (`ignore/codeflow-report.json`); the manifest below
// is the subset this change split, plus the sibling modules it created.
//
// The function counter mirrors CodeFlow's headless parser path
// (`Parser.extractOtherLanguages`, analyzer ref b0e82d1 / CODEFLOW_ANALYZER
// block) line-for-line: one regex per language family, deduped by `name@line`.
// It is verified to reproduce `functionCount` for every TS/Go/Rust file in the
// report. If the analyzer's rules change, this mirror must be re-derived.
//
// Run: node --experimental-strip-types --test test/large-refactor-2001.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Files this change split, and the siblings each split produced. */
const TOUCHED: Record<string, string[]> = {
	".pi/extensions/supervisor/test/helpers/capture.ts": [
		".pi/extensions/supervisor/test/helpers/capture-core.ts",
		".pi/extensions/supervisor/test/helpers/mock-pi.ts",
		".pi/extensions/supervisor/test/helpers/mock-ctx.ts",
	],
	".pi/extensions/scrapling/test/index.test.ts": [
		".pi/extensions/scrapling/test/index-registration.test.ts",
		".pi/extensions/scrapling/test/index-validation.test.ts",
		".pi/extensions/scrapling/test/index-concurrency.test.ts",
	],
	".pi/extensions/supervisor/pipeline/state-checkpoint.ts": [
		".pi/extensions/supervisor/pipeline/checkpoint-file.ts",
		".pi/extensions/supervisor/pipeline/run-lock.ts",
		".pi/extensions/supervisor/pipeline/stale-cleanup.ts",
	],
	".pi/extensions/supervisor/pipeline/worktree.ts": [
		".pi/extensions/supervisor/pipeline/worktree-guard.ts",
	],
	".pi/extensions/supervisor/github/octokit-client.ts": [
		".pi/extensions/supervisor/github/octokit-queries.ts",
	],
	".pi/extensions/supervisor/pipeline/stages/core.ts": [
		".pi/extensions/supervisor/pipeline/stages/status-resolution.ts",
		".pi/extensions/supervisor/pipeline/stages/gate-context.ts",
	],
	".pi/extensions/ask-user/jsonl-logger.ts": [
		".pi/extensions/ask-user/jsonl-codec.ts",
		".pi/extensions/ask-user/csv-migration.ts",
	],
	".pi/skills/audit-codeflow-analysis/lib/report.ts": [
		".pi/skills/audit-codeflow-analysis/lib/report-markdown.ts",
		".pi/skills/audit-codeflow-analysis/lib/report-json.ts",
	],
	"cmd/cheasee-pi/about_test.go": ["cmd/cheasee-pi/about_contract_test.go"],
	"cmd/cheasee-pi/auth_envvars_test.go": ["cmd/cheasee-pi/auth_envvars_provider_test.go"],
	"cmd/cheasee-pi/entrypoint_symlink_test.go": ["cmd/cheasee-pi/entrypoint_link_test.go"],
	"cmd/cheasee-pi/dockerfile_browser_test.go": [
		"cmd/cheasee-pi/dockerfile_browser_constraints_test.go",
	],
	"cmd/cheasee-pi/template_test.go": ["cmd/cheasee-pi/template_cheasee_settings_test.go"],
	"cmd/cheasee-pi/cli_doc_test.go": [
		"cmd/cheasee-pi/cli_doc_ui_test.go",
		"cmd/cheasee-pi/cli_doc_semantics_test.go",
	],
	"cmd/cheasee-pi/prune_test.go": [
		"cmd/cheasee-pi/prune_images_test.go",
		"cmd/cheasee-pi/prune_gate_test.go",
	],
};

const ALL_FILES = [...Object.keys(TOUCHED), ...Object.values(TOUCHED).flat()];

/** CodeFlow's `godFiles` predicate: strictly more than 15 functions. */
const CEILING = 15;

// ─── CodeFlow function-count mirror ───────────────────────────────

const RULES: RegExp[] = [
	/(?:public|private|protected|internal|static|final|override|virtual|abstract|async)\s+(?:(?:static|final|override|virtual|abstract|async)\s+)*(?:\w+\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/,
	/(?:suspend\s+)?fun\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/,
	/^\s*def\s+(?:self\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*[?!=]?)/,
	/(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/,
	/(?:public|private|protected|static)?\s*function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/,
	/^(?:static\s+)?(?:inline\s+)?(?:virtual\s+)?(?:\w+\s+)+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^;]*$/,
	/(?:public|private|internal|fileprivate|open)?\s*(?:static\s+)?(?:class\s+)?func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/,
	/\bdef\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[(\[]/,
	/\bdefp?\s+([a-zA-Z_][a-zA-Z0-9_?!]*)/,
	/(?:local\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_.:]*)\s*\(/,
	/(?:Public|Private|Friend)?\s*(?:Sub|Function)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/i,
];
const C_NEGATIVE = /^\s*(if|for|while|switch|return|sizeof|typeof)/;
const GO_RULE = /^func\s+(?:\([^)]+\)\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;
const PY_DEF = /^\s*(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;
const PY_CLASS = /^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

/** Count functions exactly the way CodeFlow's headless analyzer does. */
function countFunctions(src: string, ext: string): number {
	const seen = new Set<string>();
	const add = (name: string | undefined, line: number): void => {
		if (name) seen.add(`${name}@${line}`);
	};
	src.split("\n").forEach((line, idx) => {
		const lineNum = idx + 1;
		let m: RegExpMatchArray | null;
		if (ext === "go" && (m = line.match(GO_RULE))) add(m[1], lineNum);
		if (ext === "py") {
			if ((m = line.match(PY_DEF))) add(m[1], lineNum);
			if ((m = line.match(PY_CLASS))) add(m[1], lineNum);
			return;
		}
		RULES.forEach((rule, i) => {
			if ((m = line.match(rule))) {
				if (i === 5 && C_NEGATIVE.test(line)) return;
				add(i === 9 ? m[1]!.split(/[.:]/).pop() : m[1], lineNum);
			}
		});
	});
	return seen.size;
}

/** Non-blank, non-comment-first lines — the repo's own file-size measure. */
function countNBNC(src: string): number {
	return src
		.split("\n")
		.filter((l) => {
			const t = l.trim();
			return t !== "" && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*");
		}).length;
}

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const extOf = (rel: string): string => rel.split(".").pop()!;

// ─── Manifest ─────────────────────────────────────────────────────

describe("large-files refactor #2001 — manifest", () => {
	it("lists at least 12 files (non-vacuity)", () => {
		assert.ok(ALL_FILES.length >= 12, `expected >=12 manifest entries, got ${ALL_FILES.length}`);
	});

	it("every listed file exists", () => {
		for (const rel of ALL_FILES) {
			assert.ok(existsSync(resolve(ROOT, rel)), `missing manifest file: ${rel}`);
		}
	});

	it("every split file produced at least one sibling module", () => {
		for (const [rel, modules] of Object.entries(TOUCHED)) {
			assert.ok(modules.length >= 1, `${rel} lists no sibling module`);
		}
	});
});

// Note: `.mts` counts as ts (same language family in CodeFlow's ext switch).

describe("large-files refactor #2001 — metric fixture (detector has teeth)", () => {
	it("15 named functions pass; 16 fail", () => {
		const mk = (n: number): string =>
			Array.from({ length: n }, (_, i) => `export function f${i}() {}`).join("\n");
		assert.equal(countFunctions(mk(15), "ts"), 15);
		assert.ok(countFunctions(mk(15), "ts") <= CEILING, "15 must pass");
		assert.ok(countFunctions(mk(16), "ts") > CEILING, "16 must fail");
	});
});

describe("large-files refactor #2001 — split files under the metric", () => {
	for (const rel of ALL_FILES) {
		it(`${rel} has <= ${CEILING} functions and < 800 nbnc`, () => {
			const src = read(rel);
			const count = countFunctions(src, extOf(rel));
			assert.ok(
				count <= CEILING,
				`${rel} has ${count} CodeFlow functions (ceiling ${CEILING})`,
			);
			assert.ok(countNBNC(src) < 800, `${rel} is over the 800-nbnc file-size ceiling`);
		});
	}
});

describe("large-files refactor #2001 — barrels re-export explicitly", () => {
	const BARRELS = [
		".pi/extensions/supervisor/test/helpers/capture.ts",
		".pi/extensions/supervisor/pipeline/state-checkpoint.ts",
		".pi/extensions/supervisor/pipeline/worktree.ts",
		".pi/extensions/supervisor/github/octokit-client.ts",
		".pi/extensions/supervisor/pipeline/stages/core.ts",
		".pi/extensions/ask-user/jsonl-logger.ts",
		".pi/skills/audit-codeflow-analysis/lib/report.ts",
	];

	for (const rel of BARRELS) {
		it(`${rel} uses explicit re-exports, no star re-export`, () => {
			const src = read(rel);
			assert.ok(!/export\s+\*/.test(src), `${rel} must not use \`export *\``);
		});
	}
});

describe("large-files refactor #2001 — sibling modules import standalone", () => {
	for (const modules of Object.values(TOUCHED)) {
		for (const rel of modules) {
			// Test files install hooks when imported, and Go package-main test files
			// are compiled by `go test` — only importable TS/JS helpers are loaded.
			if (!/\.(ts|mts)$/.test(rel) || /\.test\.(ts|mts)$/.test(rel)) continue;
			it(`${rel} imports without error`, async () => {
				const mod = await import(new URL(rel, `file://${ROOT}/`).href);
				assert.ok(mod !== null && typeof mod === "object");
			});
		}
	}
});

describe("large-files refactor #2001 — preserved contracts", () => {
	it("jsonl-logger.ts still exports readQnaEntries and calls it >= 3x", () => {
		const src = read(".pi/extensions/ask-user/jsonl-logger.ts");
		assert.ok(src.includes("export async function readQnaEntries"));
		assert.ok((src.match(/await readQnaEntries\(/g) ?? []).length >= 3);
	});

	it("scrapling test/index.test.ts carries no local ExecResult/ExecFn", () => {
		const src = read(".pi/extensions/scrapling/test/index.test.ts");
		assert.ok(!/interface\s+ExecResult\s*\{/.test(src));
		assert.ok(!/interface\s+ExecFn\s*\{/.test(src));
	});

	it("worktree-guard.ts does not import worktree.ts (acyclic)", () => {
		const src = read(".pi/extensions/supervisor/pipeline/worktree-guard.ts");
		assert.ok(!src.includes('from "./worktree.ts"'));
	});

	it("report.ts stays the only triage-policy source", () => {
		for (const rel of [
			".pi/skills/audit-codeflow-analysis/lib/report-markdown.ts",
			".pi/skills/audit-codeflow-analysis/lib/report-json.ts",
		]) {
			const src = read(rel);
			assert.ok(!src.includes("classifyFinding"), `${rel} must not carry triage policy`);
			assert.ok(!src.includes("groupIssues"), `${rel} must not carry triage policy`);
		}
		const policy = read(".pi/skills/audit-codeflow-analysis/lib/report.ts");
		for (const sym of ["classifyFinding", "groupIssues", "dedupeIssues"]) {
			assert.ok(policy.includes(`export function ${sym}`), `report.ts must still export ${sym}`);
		}
	});
});
