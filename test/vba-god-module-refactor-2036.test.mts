// ─── VBA-god-module refactor contract (issue #2036) ───────────────
// The issue files the `VBA God Module` metric with a 25-file set. On the pinned
// base (origin/main 463f382c) the analyzer's parser reports exactly those 25
// over the 20-declaration ceiling. This branch reduces every cited module that
// was flagged (23 of them) by verbatim moves into siblings of the same module
// tree — re-export barrels in TS, `mod`/`pub use` in Rust, sibling imports in
// Python — and records the two files that were already under the ceiling.
//
// The oracle re-runs the detector over BOTH trees: `acorn-babel-mirror.mts`
// reproduces the acorn branch (the one the browser export used — object-literal
// methods and arrow properties count) and `function-count-mirror.mts` the regex
// branch used for `.py/.go/.rs`. A regression that leaves a cited module over
// the ceiling, a module that was never really flagged at the base, a sibling
// that re-enters the anti-pattern set, or a deferred file that is not cited all
// fail here.
//
// Run: node --experimental-strip-types --test test/vba-god-module-refactor-2036.test.mts

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createMockAPI, makeEvent } from "../.pi/extensions/agent-harness/test/harness-fixtures.ts";
import { commandStubs } from "../.pi/extensions/agent-harness/test/harness-api-stubs.ts";
import { sessionStubs } from "../.pi/extensions/agent-harness/test/harness-api-stubs-session.ts";
import {
	normalizeEvent,
	processNormalizedEvent,
} from "../.pi/extensions/supervisor/event/adapter/normalize.ts";
import { coreKindTable } from "../.pi/extensions/supervisor/event/adapter/normalize-table-core.ts";
import { deltaKindTable } from "../.pi/extensions/supervisor/event/adapter/normalize-table-deltas.ts";
import {
	createDebugLogger,
	getDebugLogger,
	resetDebugLogger,
} from "../.pi/extensions/supervisor/lib/debug.ts";
import { formatTimestamp } from "../.pi/extensions/supervisor/lib/debug-format.ts";
import { makeSentinelTheme } from "../.pi/extensions/caveman/test/config-ui-test-theme.ts";
import {
	createMockPi,
	createMockTheme,
	createMockUI,
	createMockSessionManager,
	createMockModelRegistry,
} from "../.pi/extensions/supervisor/test/helpers/mock-pi.ts";
import { CapturedOutput } from "../.pi/extensions/supervisor/test/helpers/capture-core.ts";
import { countAcornBabelFunctions } from "./fixtures/acorn-babel-mirror.mts";
import { countFunctions } from "./fixtures/function-count-mirror.mts";
import { CODE_EXTS } from "./fixtures/long-file-mirror.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ACORN_EXTS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"]);
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const missingPaths = (paths: string[]): string[] =>
	paths.filter((rel) => !existsSync(resolve(ROOT, rel)));
const overlap = (a: string[], b: string[]): string[] => a.filter((rel) => b.includes(rel));

/** The pinned analyzer's own extension gate (`codeExts` / `isCode !== false`). */
const scored = (rel: string): boolean => CODE_EXTS.includes(`.${rel.split(".").pop()}`);

/** Re-run the pinned detector over one file of one tree. */
function countIn(root: string, rel: string): number {
	const ext = rel.split(".").pop()!;
	const src = readFileSync(resolve(root, rel), "utf-8");
	return ACORN_EXTS.has(ext) ? countAcornBabelFunctions(src, ext) : countFunctions(src, ext);
}

/** Re-run the pinned detector over one path in the current tree. */
const measure = (rel: string): number => countIn(ROOT, rel);

const git = (...args: string[]): string[] =>
	execFileSync("git", args, { cwd: ROOT, encoding: "utf-8", maxBuffer: 1 << 28 })
		.split("\n")
		.filter(Boolean);

/** Every measured file of one tree: `> 20` is `VBA God Module`, `> 15` `God Object`. */
function measureTree(root: string, paths: string[]) {
	const counts = new Map<string, number>();
	for (const rel of paths.filter(scored)) counts.set(rel, countIn(root, rel));
	const over = (ceiling: number): string[] =>
		[...counts]
			.filter(([, n]) => n > ceiling)
			.map(([rel]) => rel)
			.sort();
	return {
		codeFiles: counts.size,
		vbaGodModule: over(B.threshold),
		godObject: over(B.godObjectThreshold),
	};
}

/** The pinned base commit unpacked once per run, or null when the checkout lacks it. */
let baseRoot: string | null | undefined;
function base(): string | null {
	if (baseRoot !== undefined) return baseRoot;
	try {
		execFileSync("git", ["cat-file", "-e", `${B.before.commit}^{commit}`], {
			cwd: ROOT,
			stdio: "ignore",
		});
	} catch {
		return (baseRoot = null);
	}
	const dir = mkdtempSync(join(tmpdir(), "vba-2036-base-"));
	execFileSync("bash", ["-c", `git archive ${B.before.commit} | tar -x -C ${dir}`], { cwd: ROOT });
	return (baseRoot = dir);
}

// The unpacked archive is a ~14 MB copy of the base tree; drop it after the run.
after(() => {
	if (baseRoot) rmSync(baseRoot, { recursive: true, force: true });
});

const B = JSON.parse(read("test/fixtures/vba-god-module-baseline-2036.json")) as {
	provenance: {
		issue: number;
		title: string;
		ref: string;
		parserMode: string;
		mirror: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
	threshold: number;
	godObjectThreshold: number;
	before: {
		commit: string;
		codeFiles: number;
		vbaGodModuleCount: number;
		godObjectCount: number;
	};
	after: {
		ref: string;
		codeFiles: number;
		vbaGodModuleCount: number;
		godObjectCount: number;
	};
	tradeoffs: Record<string, string>;
	baseAdvance: { issue: number; reason: string; scoredFilesAdded: number; resolvedFiles: string[] };
	reducedBy: string[];
	filedFiles: string[];
	alreadyUnder: { reason: string; files: string[] };
	splitFamilies: Record<string, string[]>;
	deferred: { reason: string; files?: string[]; examples?: string[] }[];
};

const SIBLINGS = Object.values(B.splitFamilies).flat();
// Issue #2023 adds these two scored extension files to the delivered tree.
const ADDITIONAL_SCORED_FILES = [
	".pi/extensions/lib/safe-argv.ts",
	".pi/extensions/lib/test/safe-argv.test.ts",
];
const DEFERRED = B.deferred.flatMap((d) => d.files ?? []);
const BASE_UNCITED = [...DEFERRED, ...B.baseAdvance.resolvedFiles];
const ALREADY_UNDER = B.alreadyUnder.files;

// ─── Manifest ─────────────────────────────────────────────────────

describe("vba god module refactor #2036 — manifest", () => {
	it("pins the 40-hex analyzer ref, the acorn-babel parser branch and its mirror", () => {
		assert.match(B.provenance.ref, /^[0-9a-f]{40}$/);
		assert.equal(B.provenance.parserMode, "acorn-babel");
		assert.ok(existsSync(resolve(ROOT, B.provenance.mirror)), "mirror module exists");
		assert.equal(B.threshold, 20, "the VBA God Module ceiling");
		assert.equal(B.godObjectThreshold, 15, "the God Object ceiling");
	});

	it("cites the 23 reduced modules and their 58 siblings", () => {
		assert.deepStrictEqual(Object.keys(B.splitFamilies).sort(), [...B.reducedBy].sort());
		assert.equal(SIBLINGS.length, 58, "fifty-eight new siblings for the twenty-three families");
		assert.equal(new Set(SIBLINGS).size, SIBLINGS.length, "a sibling is listed twice");
	});

	it("accounts for every filed file: reduced, already under, or uncited-deferred", () => {
		assert.equal(B.filedFiles.length, B.provenance.filedCount, "the issue filed 25 files");
		assert.deepStrictEqual(
			overlap(B.reducedBy, ALREADY_UNDER),
			[],
			"a file is both reduced and skipped",
		);
		assert.deepStrictEqual(
			[...B.reducedBy, ...ALREADY_UNDER].sort(),
			[...B.filedFiles].sort(),
			"every filed file is either reduced here or recorded as already under the base ceiling",
		);
		assert.deepStrictEqual(
			overlap(DEFERRED, B.filedFiles),
			[],
			"a deferred file that the issue cites means the refactor is unfinished",
		);
	});

	it("every reduced module and every sibling exists and is a scored extension", () => {
		for (const mod of [...B.reducedBy, ...SIBLINGS]) {
			assert.ok(existsSync(resolve(ROOT, mod)), `missing manifest module: ${mod}`);
			assert.ok(scored(mod), `${mod} is never scored by the analyzer`);
		}
	});

	it("no sibling is itself a reduction source or a deferral", () => {
		assert.deepStrictEqual(overlap(SIBLINGS, B.reducedBy), []);
		assert.deepStrictEqual(overlap(SIBLINGS, DEFERRED), []);
		assert.deepStrictEqual(overlap(B.reducedBy, DEFERRED), []);
	});
});

// ─── The moves are structural, and the barrels preserve the surface ─

describe("vba god module refactor #2036 — moved declarations live in the siblings", () => {
	it("harness-fixtures delegates its stub object to the two stub factories", () => {
		const barrel = read(".pi/extensions/agent-harness/test/harness-fixtures.ts");
		assert.match(barrel, /from "\.\/harness-api-stubs\.ts"/);
		assert.match(barrel, /from "\.\/harness-api-stubs-session\.ts"/);
		assert.ok(
			!barrel.includes("registerTool: () => {}"),
			"the inline stub object must not remain in harness-fixtures.ts",
		);
		assert.match(
			read(".pi/extensions/agent-harness/test/harness-api-stubs.ts"),
			/registerTool: \(\) => \{\}/,
		);
		assert.match(
			read(".pi/extensions/agent-harness/test/harness-api-stubs-session.ts"),
			/getActiveTools: \(\) => \[\]/,
		);
	});

	it("normalize merges the two kind tables and re-exports the moved types", () => {
		const barrel = read(".pi/extensions/supervisor/event/adapter/normalize.ts");
		assert.match(barrel, /\.\.\.coreKindTable, \.\.\.deltaKindTable/);
		assert.match(barrel, /from "\.\/normalize-types\.ts"/);
		assert.ok(!barrel.includes("tool_execution_start: {"), "the kind table moved out");
		assert.match(
			read(".pi/extensions/supervisor/event/adapter/normalize-table-core.ts"),
			/export const coreKindTable/,
		);
		assert.match(
			read(".pi/extensions/supervisor/event/adapter/normalize-table-deltas.ts"),
			/export const deltaKindTable/,
		);
	});

	it("debug re-exports the logger factory from the new module", () => {
		const barrel = read(".pi/extensions/supervisor/lib/debug.ts");
		assert.match(barrel, /export \{ createDebugLogger \};/);
		assert.ok(!barrel.includes("function createDebugLogger("), "the factory moved out");
		assert.match(
			read(".pi/extensions/supervisor/lib/debug-logger.ts"),
			/export function createDebugLogger\(/,
		);
		assert.match(
			read(".pi/extensions/supervisor/lib/debug-format.ts"),
			/export function formatTimestamp\(/,
		);
		assert.match(
			read(".pi/extensions/supervisor/lib/debug-sanitize.ts"),
			/export function sanitizeData\(/,
		);
	});

	it("config-ui hands the dialog suite to its sibling with a shared theme mock", () => {
		const barrel = read(".pi/extensions/caveman/test/config-ui.test.ts");
		assert.ok(!barrel.includes("openConfigDialog header styling"), "the dialog suite moved out");
		assert.match(
			read(".pi/extensions/caveman/test/config-ui-dialog.test.ts"),
			/openConfigDialog header styling/,
		);
		assert.match(
			read(".pi/extensions/caveman/test/config-ui-test-theme.ts"),
			/export function makeSentinelTheme\(/,
		);
	});

	it("mock-pi spreads per-responsibility stub groups and re-exports every factory", () => {
		const barrel = read(".pi/extensions/supervisor/test/helpers/mock-pi.ts");
		for (const sib of [
			"mock-pi-api-commands.ts",
			"mock-pi-api-tools.ts",
			"mock-pi-api-runtime.ts",
		]) {
			assert.match(barrel, new RegExp(sib.replace(".", "\\.")), `mock-pi spreads ${sib}`);
		}
		for (const factory of [
			"createMockTheme",
			"createMockUI",
			"createMockSessionManager",
			"createMockModelRegistry",
		]) {
			assert.match(
				barrel,
				new RegExp(`export \\{ ${factory} \\}`),
				`mock-pi re-exports ${factory}`,
			);
		}
		assert.ok(
			!barrel.includes("registerTool(_tool: any)"),
			"the ExtensionAPI stub object moved out of mock-pi.ts",
		);
		assert.match(
			read(".pi/extensions/supervisor/test/helpers/mock-pi-api-tools.ts"),
			/registerTool\(_tool: any\)/,
		);
	});

	it("run-analysis.mjs inlined its single-use string skipper", () => {
		const src = read("cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs");
		assert.ok(!src.includes("function skipString("), "the helper was inlined, not kept");
		assert.ok(
			src.includes("if (src[i] === ch)") && src.includes('if (src[i] === "\\\\")'),
			"the inlined scan preserves the escape/terminator handling",
		);
	});

	it("every moved Rust child is declared by its parent and every Python sibling is imported", () => {
		for (const [parent, kids] of Object.entries(B.splitFamilies)) {
			for (const kid of kids) {
				if (kid.endsWith(".py")) {
					assert.match(
						read(parent),
						new RegExp(`^from ${basename(kid, ".py")} import`, "m"),
						`${parent} must import the moved module ${kid}`,
					);
				} else if (kid.endsWith(".rs")) {
					const stem = basename(kid, ".rs");
					const inlined = kid.replace(/\/[^/]+\.rs$/, ".rs");
					const testModule = kid.replace(/\/tests_[^/]+\.rs$/, "/tests.rs");
					const declaring =
						testModule !== kid && existsSync(resolve(ROOT, testModule))
							? testModule
							: existsSync(resolve(ROOT, inlined))
								? inlined
								: parent;
					assert.match(
						read(declaring),
						new RegExp(`\\bmod ${stem};`),
						`${declaring} must declare mod ${stem}; for ${kid}`,
					);
				}
			}
		}
	});
});

// ─── The public surface still resolves through the barrels ─────────

describe("vba god module refactor #2036 — public surface preserved", () => {
	it("harness-fixtures still exports a working createMockAPI", () => {
		const api = createMockAPI();
		assert.equal(typeof api.on, "function");
		assert.equal(typeof api.fire, "function");
		api.on("x", () => {});
		assert.equal(api.fire("x", 1), undefined);
		assert.equal(api.getFlag("nope"), undefined);
		assert.equal(typeof makeEvent, "function");
		assert.equal(typeof commandStubs, "function");
		assert.equal(typeof sessionStubs, "function");
	});

	it("normalize still normalizes and dispatches through the merged table", () => {
		assert.deepEqual(normalizeEvent("json", { type: "session" }), { kind: "session" });
		assert.deepEqual(normalizeEvent("json", { type: "text_start" }), { kind: "text_start" });
		assert.equal(Object.keys(coreKindTable).length, 10);
		assert.equal(Object.keys(deltaKindTable).length, 6);
		const state = {
			currentTool: undefined,
			toolCount: 0,
			fullLog: [],
			liveThinking: "",
			liveText: "",
			textOutputLines: [],
			thinkingOutputLines: [],
			phase: "idle",
		} as any;
		assert.deepEqual(processNormalizedEvent({ kind: "session" }, state), {
			flush: false,
			workingChange: false,
		});
	});

	it("debug still creates a logger with the child/getLogPath contract", () => {
		resetDebugLogger();
		assert.equal(typeof getDebugLogger().debug, "function");
		const logger = createDebugLogger("/tmp", "issue-2036-oracle");
		assert.equal(logger.getSessionId(), "issue-2036-oracle");
		const child = logger.child("a");
		assert.equal(child.getSessionId(), "issue-2036-oracle");
		assert.equal(child.getLogPath(), logger.getLogPath());
		assert.equal(typeof formatTimestamp(new Date()), "string");
	});

	it("the sentinel theme mock still reports style/fg/bold calls", () => {
		const { theme, styleCalls, fgCalls, boldCalls } = makeSentinelTheme();
		theme.style("h", { fg: "accent", bold: true });
		theme.fg("accent", "t");
		theme.bold("b");
		assert.equal(styleCalls.length, 1);
		assert.deepEqual(fgCalls, ["t"]);
		assert.deepEqual(boldCalls, ["b"]);
	});

	it("mock-pi still composes a working ExtensionAPI from the stub groups", () => {
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);
		pi.sendMessage({ customType: "oracle", content: "hi", display: true });
		assert.equal(captured.messages.length, 1);
		assert.equal(pi.getFlag("none"), undefined);
		assert.deepEqual(pi.getActiveTools(), []);
		pi.registerTool({});
		assert.equal(typeof createMockTheme().fg, "function");
		const ui = createMockUI(captured);
		ui.notify("hello", "info");
		assert.equal(captured.notifications.at(-1)?.msg, "hello");
		assert.equal(createMockSessionManager().getSessionId(), "mock-session-id");
		assert.equal(createMockModelRegistry().getModel(), undefined);
	});
});

// ─── The detector re-measures both trees ──────────────────────────

describe("vba god module refactor #2036 — live detector over the current tree", () => {
	it("the mirror reproduces the recorded base envelope", (t) => {
		// The mirror is only trustworthy if it matches the analyzer on the base
		// snapshot the fixture records (the issue's filed numbers). The base
		// commit is a local ref in the pipeline worktree; where it is absent
		// (e.g. a shallow CI checkout) the current-tree checks below still run.
		const dir = base();
		if (!dir) return t.skip(`base commit ${B.before.commit} is not present in this checkout`);
		const recorded: Record<string, number> = {
			".pi/extensions/agent-harness/test/harness-fixtures.ts": 37,
			".pi/extensions/caveman/test/config-ui.test.ts": 36,
			".pi/extensions/supervisor/event/adapter/normalize.ts": 22,
			".pi/extensions/supervisor/lib/debug.ts": 32,
			".pi/extensions/supervisor/test/helpers/mock-pi.ts": 93,
			"cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs": 21,
			"cmd/cheasee-pi/embedded/docker/codeflow/server.py": 51,
			"cmd/cheasee-pi/embedded/docker/ui/src/retry.rs": 62,
			"cmd/cheasee-pi/embedded/docker/ui/src/stream.rs": 72,
		};
		for (const [rel, n] of Object.entries(recorded)) {
			assert.equal(countIn(dir, rel), n, `mirror drift against ${B.before.commit} on ${rel}`);
		}
	});

	it("every cited module was flagged at the base and is under the ceiling now", (t) => {
		const dir = base();
		for (const rel of B.reducedBy) {
			if (dir) {
				assert.ok(
					countIn(dir, rel) > B.threshold,
					`${rel} measures ${countIn(dir, rel)} at ${B.before.commit}: it was not flagged, so it is not a reduction`,
				);
			}
			assert.ok(
				measure(rel) <= B.threshold,
				`${rel} is still over the ceiling (${measure(rel)} > ${B.threshold})`,
			);
		}
	});

	it("the two cited modules that were already under the base ceiling are still under it", (t) => {
		const dir = base();
		for (const rel of ALREADY_UNDER) {
			if (dir)
				assert.ok(countIn(dir, rel) <= B.threshold, `${rel} was flagged at ${B.before.commit}`);
			assert.ok(measure(rel) <= B.threshold, `${rel} is over the ceiling (${measure(rel)})`);
		}
	});

	it("no sibling re-enters the anti-pattern set", () => {
		for (const rel of SIBLINGS) {
			assert.ok(
				measure(rel) <= B.threshold,
				`${rel} lands at ${measure(rel)} > ${B.threshold}: the split must not carry the anti-pattern into a sibling`,
			);
		}
	});

	it("every deferred file is uncited and still over the ceiling in the current tree", () => {
		for (const rel of DEFERRED) {
			assert.ok(
				measure(rel) > B.threshold,
				`${rel} measures ${measure(rel)} <= ${B.threshold}: it is no longer flagged`,
			);
		}
	});

	it("re-measures the delivered tree: only the uncited leftovers stay flagged", () => {
		const after = measureTree(ROOT, git("ls-files"));
		assert.equal(
			after.codeFiles,
			B.after.codeFiles + ADDITIONAL_SCORED_FILES.filter(scored).length,
			"recorded scored-file count drifted",
		);
		assert.equal(after.vbaGodModule.length, B.after.vbaGodModuleCount);
		assert.deepStrictEqual(
			after.vbaGodModule,
			[...DEFERRED].sort(),
			"a flag outside the deferral ledger",
		);
		assert.equal(after.godObject.length, B.after.godObjectCount);
	});

	it("re-measures the pinned base: 25 flagged, and the split mints no God Object", (t) => {
		const dir = base();
		if (!dir) return t.skip(`base commit ${B.before.commit} is not present in this checkout`);
		const before = measureTree(dir, git("ls-tree", "-r", "--name-only", B.before.commit));
		assert.equal(before.codeFiles, B.before.codeFiles, "recorded base scored-file count drifted");
		assert.equal(before.vbaGodModule.length, B.before.vbaGodModuleCount);
		assert.deepStrictEqual(
			before.vbaGodModule,
			[...B.reducedBy, ...BASE_UNCITED].sort(),
			"the base's flagged set must include the reductions and both uncited paths",
		);
		assert.equal(before.godObject.length, B.before.godObjectCount);
		const after = measureTree(ROOT, git("ls-files"));
		assert.ok(
			after.godObject.length <= before.godObject.length,
			`God Object grew ${before.godObject.length} -> ${after.godObject.length}`,
		);
	});

	it("accounts for every leftover flag (no silent omission)", () => {
		assert.strictEqual(
			B.before.vbaGodModuleCount,
			B.reducedBy.length + BASE_UNCITED.length,
			"base count must equal reduced + uncited flags",
		);
		assert.strictEqual(
			B.after.vbaGodModuleCount,
			DEFERRED.length,
			"every file still flagged on the delivered tree is a recorded deferral",
		);
		assert.strictEqual(
			B.after.codeFiles,
			B.before.codeFiles + SIBLINGS.length + B.baseAdvance.scoredFilesAdded,
			"the drop is from splitting, not deleting: account for this split and the main advance",
		);
	});

	it("fails closed on a missing or doubly-cited path", () => {
		assert.deepStrictEqual(missingPaths(["test/fixtures/acorn-babel-mirror.mts"]), []);
		assert.deepStrictEqual(missingPaths(["test/no-such-sibling-2036.ts"]), [
			"test/no-such-sibling-2036.ts",
		]);
		assert.deepStrictEqual(overlap(["a.ts", "b.ts"], ["b.ts"]), ["b.ts"]);
	});
});
