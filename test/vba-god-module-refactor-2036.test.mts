// ─── VBA-god-module refactor contract (issue #2036) ───────────────
// The issue re-files the `VBA God Module` metric with a new file set (25).
// On the immutable base (origin/main c89a4d27) the pinned analyzer's
// acorn-babel branch reports 25 flagged files. This branch reduces six of the
// cited modules by verbatim moves into siblings (each <= 15) with re-export
// barrels; the rest are measured and deferred with a reason.
//
// Unlike a recorded-count ledger, this oracle re-runs the detector over the
// CURRENT tree: `acorn-babel-mirror.mts` reproduces the acorn branch (the one
// the browser export used — object-literal methods and arrow properties count)
// and `function-count-mirror.mts` reproduces the regex branch used for
// `.py/.go/.rs`. A regression that leaves a split module over the ceiling, or
// a deferred file under it, fails here.
//
// Run: node --experimental-strip-types --test test/vba-god-module-refactor-2036.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { acornBabelFlagged, countAcornBabelFunctions } from "./fixtures/acorn-babel-mirror.mts";
import { countFunctions } from "./fixtures/function-count-mirror.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ACORN_EXTS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"]);
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const missingPaths = (paths: string[]): string[] =>
	paths.filter((rel) => !existsSync(resolve(ROOT, rel)));
const overlap = (a: string[], b: string[]): string[] => a.filter((rel) => b.includes(rel));

/** Re-run the pinned detector over one path in the current tree. */
function measure(rel: string): number {
	const ext = rel.split(".").pop()!;
	const src = read(rel);
	return ACORN_EXTS.has(ext) ? countAcornBabelFunctions(src, ext) : countFunctions(src, ext);
}

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
	before: { commit: string; files: number; vbaGodModuleCount: number };
	after: { ref: string; files: number; vbaGodModuleCount: number };
	tradeoffs: Record<string, string>;
	reducedBy: string[];
	splitFamilies: Record<string, string[]>;
	deferred: { reason: string; files?: string[]; examples?: string[] }[];
};

const SIBLINGS = Object.values(B.splitFamilies).flat();
const DEFERRED = B.deferred.flatMap((d) => d.files ?? []);

// ─── Manifest ─────────────────────────────────────────────────────

describe("vba god module refactor #2036 — manifest", () => {
	it("pins the 40-hex analyzer ref, the acorn-babel parser branch and its mirror", () => {
		assert.match(B.provenance.ref, /^[0-9a-f]{40}$/);
		assert.equal(B.provenance.parserMode, "acorn-babel");
		assert.ok(existsSync(resolve(ROOT, B.provenance.mirror)), "mirror module exists");
		assert.equal(B.threshold, 20, "the VBA God Module ceiling");
	});

	it("cites the six reduced modules and their 22 siblings", () => {
		assert.deepStrictEqual(Object.keys(B.splitFamilies).sort(), [...B.reducedBy].sort());
		assert.equal(SIBLINGS.length, 22, "twenty-two new siblings for the six families");
		assert.equal(new Set(SIBLINGS).size, SIBLINGS.length, "a sibling is listed twice");
	});

	it("every reduced module and every sibling exists and is a scored extension", () => {
		for (const mod of [...B.reducedBy, ...SIBLINGS]) {
			assert.ok(existsSync(resolve(ROOT, mod)), `missing manifest module: ${mod}`);
			assert.ok(!mod.endsWith(".mts"), `${mod} is never scored by the analyzer`);
			assert.ok(
				/\.(ts|js|mjs|py|rs|go)$/.test(mod),
				`${mod} must be a scored source file extension`,
			);
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

// ─── The detector re-measures the current tree ────────────────────

describe("vba god module refactor #2036 — live detector over the current tree", () => {
	it("the acorn-babel mirror reproduces the recorded base envelope", (t) => {
		// The mirror is only trustworthy if it matches the analyzer on the base
		// snapshot the fixture records (the issue's filed numbers). The base
		// commit is a local ref in the pipeline worktree; where it is absent
		// (e.g. a shallow CI checkout) the current-tree checks below still run.
		try {
			execFileSync("git", ["cat-file", "-e", `${B.before.commit}^{commit}`], { stdio: "ignore" });
		} catch {
			return t.skip(`base commit ${B.before.commit} is not present in this checkout`);
		}
		const recorded: Record<string, number> = {
			".pi/extensions/agent-harness/test/harness-fixtures.ts": 37,
			".pi/extensions/caveman/test/config-ui.test.ts": 36,
			".pi/extensions/supervisor/event/adapter/normalize.ts": 22,
			".pi/extensions/supervisor/lib/debug.ts": 32,
			".pi/extensions/supervisor/test/helpers/mock-pi.ts": 93,
			"cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs": 21,
		};
		const dir = mkdtempSync(join(tmpdir(), "vba-2036-base-"));
		execFileSync("bash", ["-c", `git archive ${B.before.commit} | tar -x -C ${dir}`]);
		for (const [rel, n] of Object.entries(recorded)) {
			const ext = rel.split(".").pop()!;
			assert.equal(
				countAcornBabelFunctions(readFileSync(join(dir, rel), "utf-8"), ext),
				n,
				`mirror drift against ${B.before.commit} on ${rel}`,
			);
		}
	});

	it("every reduced module and sibling is under the ceiling in the current tree", () => {
		for (const rel of B.reducedBy) {
			assert.ok(
				!acornBabelFlagged(read(rel), rel, B.threshold),
				`${rel} is still over the ceiling (${measure(rel)} > ${B.threshold})`,
			);
		}
		for (const rel of SIBLINGS) {
			assert.ok(
				measure(rel) <= 15,
				`${rel} lands at ${measure(rel)}, which would mint a God Object (> 15)`,
			);
		}
	});

	it("every deferred file is still over the ceiling in the current tree (not silently passed)", () => {
		for (const rel of DEFERRED) {
			assert.ok(
				measure(rel) > B.threshold,
				`${rel} measures ${measure(rel)} <= ${B.threshold}: it is no longer flagged`,
			);
		}
	});

	it("accounts for every leftover flag (no silent omission)", () => {
		assert.strictEqual(
			B.before.vbaGodModuleCount,
			B.reducedBy.length + DEFERRED.length,
			"base count must equal reduced + deferred",
		);
		assert.strictEqual(
			B.after.vbaGodModuleCount,
			DEFERRED.length,
			"every file still flagged on the delivered tree is a recorded deferral",
		);
		assert.strictEqual(
			B.after.files,
			B.before.files + SIBLINGS.length,
			"the drop is from splitting, not deleting: files grow by the sibling count",
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
