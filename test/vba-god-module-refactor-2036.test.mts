// ─── VBA-god-module refactor contract (issue #2036) ───────────────
// The issue re-files the `VBA God Module` metric with a new file set (25).
// On the immutable base (origin/main c89a4d27) the analyzer reports 25 files,
// of which four `.pi/extensions` modules are reduced here by verbatim moves into
// siblings (each <= 15) with re-export barrels; the rest are measured and
// deferred with a reason.
//
// The detector is the acorn-babel branch of the pinned analyzer — object-literal
// methods and arrow properties count, so a plain `function`/`def` regex misses
// the TS/JS flags. The measurement therefore stays out of the in-gate suite; the
// recorded envelope is `test/fixtures/vba-god-module-baseline-2036.json` and
// this oracle guards the split's structure and the ledger.
//
// Run: node --experimental-strip-types --test test/vba-god-module-refactor-2036.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const missingPaths = (paths: string[]): string[] =>
	paths.filter((rel) => !existsSync(resolve(ROOT, rel)));
const overlap = (a: string[], b: string[]): string[] => a.filter((rel) => b.includes(rel));

const B = JSON.parse(read("test/fixtures/vba-god-module-baseline-2036.json")) as {
	provenance: {
		issue: number;
		title: string;
		ref: string;
		parserMode: string;
		metric: string;
		filedCount: number;
		filedAnalyzedAt: number;
	};
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
	it("pins the 40-hex analyzer ref and the acorn-babel parser branch", () => {
		assert.match(B.provenance.ref, /^[0-9a-f]{40}$/);
		assert.equal(B.provenance.parserMode, "acorn-babel");
	});

	it("cites the four reduced modules and their siblings", () => {
		assert.deepStrictEqual(Object.keys(B.splitFamilies).sort(), [...B.reducedBy].sort());
		assert.equal(SIBLINGS.length, 10, "ten new siblings for the four families");
		assert.equal(new Set(SIBLINGS).size, SIBLINGS.length, "a sibling is listed twice");
	});

	it("every reduced module and every sibling exists and is never a `.mts`", () => {
		for (const mod of [...B.reducedBy, ...SIBLINGS]) {
			assert.ok(existsSync(resolve(ROOT, mod)), `missing manifest module: ${mod}`);
			assert.ok(!mod.endsWith(".mts"), `${mod} is never scored by the analyzer`);
			assert.ok(mod.endsWith(".ts"), `${mod} must be a scored .ts file`);
		}
	});

	it("no sibling is itself a reduction source or a deferral", () => {
		assert.deepStrictEqual(overlap(SIBLINGS, B.reducedBy), []);
		assert.deepStrictEqual(overlap(SIBLINGS, DEFERRED), []);
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
});

// ─── Recorded envelope ────────────────────────────────────────────

describe("vba god module refactor #2036 — recorded envelope", () => {
	it("records a real drop between two immutable snapshots on the pinned analyzer", () => {
		assert.strictEqual(B.provenance.issue, 2036);
		assert.strictEqual(B.provenance.title, "VBA God Module");
		assert.strictEqual(B.provenance.filedCount, 25, "the issue's filed count");
		assert.strictEqual(B.provenance.filedAnalyzedAt, 1791804971015);
		assert.match(B.provenance.metric, /functions\.length > 20/, "the exact predicate");
		assert.match(B.provenance.metric, /isCode !== false/, "the `isCode` gate");
		assert.match(B.before.commit, /^[0-9a-f]{40}$/, "before must be an immutable commit");
		assert.ok(
			B.after.vbaGodModuleCount < B.before.vbaGodModuleCount,
			"the flagged-file count must fall",
		);
		assert.ok(
			B.after.files > B.before.files,
			"the split adds files; the drop is not from dropping files",
		);
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
	});

	it("defers the Rust set, the two embedded boundaries and mock-pi, all existing", () => {
		for (const entry of B.deferred) {
			assert.ok(entry.reason.length > 0, "every deferred entry states a reason");
		}
		assert.deepStrictEqual(missingPaths(DEFERRED), [], "a deferred path does not exist");
		const rust = B.deferred.find(
			(d) => (d.files?.length ?? 0) > 0 && d.files!.every((f) => f.endsWith(".rs")),
		);
		assert.ok(rust, "the Rust set is recorded as deferred");
		assert.equal(rust.files!.length, 16, "the whole measured Rust set is deferred");
		for (const rel of [
			"cmd/cheasee-pi/embedded/docker/codeflow/server.py",
			"cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs",
			".pi/extensions/supervisor/test/helpers/mock-pi.ts",
		]) {
			assert.ok(DEFERRED.includes(rel), `${rel} must be deferred`);
		}
	});

	it("fails closed on a missing or doubly-cited path", () => {
		assert.deepStrictEqual(missingPaths(["test/fixtures/vba-god-module-baseline-2036.json"]), []);
		assert.deepStrictEqual(missingPaths(["test/no-such-sibling-2036.ts"]), [
			"test/no-such-sibling-2036.ts",
		]);
		assert.deepStrictEqual(overlap(["a.ts", "b.ts"], ["b.ts"]), ["b.ts"]);
		assert.deepStrictEqual(
			overlap(B.reducedBy, DEFERRED),
			[],
			"no path is both a reduction source and a deferral",
		);
	});
});
