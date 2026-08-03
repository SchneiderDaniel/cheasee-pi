/**
 * Tests for audit package — sendUserMessage with deliverAs: "followUp" removal (Issue #604)
 *
 * Phase 1: Remove sendUserMessage calls from the audit package
 * Phase 2: CI failure path preserves behavior (ctx.ui.notify, gateFailures aggregation)
 * Phase 3: TSC checkpoint failure path preserves behavior (ctx.ui.notify, gateFailures aggregation)
 *
 * Issue #1407: audit.ts split into pipeline/audit/* — CI failure behavior lives
 * in pre-gates.ts, TSC failure behavior in tsc-gate.ts, and the failure
 * aggregation (gateFailures.push) in the orchestrator index.ts.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/audit-sendusermessage.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUDIT_DIR = resolve(__dirname, "../pipeline/audit");
const PRE_GATES_TS = join(AUDIT_DIR, "pre-gates.ts");
const TSC_GATE_TS = join(AUDIT_DIR, "tsc-gate.ts");
const INDEX_TS = join(AUDIT_DIR, "index.ts");

function readSource(filePath: string): string {
	return readFileSync(filePath, "utf-8");
}

// ===========================================================================
// Phase 1: Remove sendUserMessage calls from the audit package
// ===========================================================================

describe("pipeline/audit — sendUserMessage removed (Phase 1)", () => {
	it("no sendUserMessage anywhere in the audit package", () => {
		for (const file of readdirSync(AUDIT_DIR)) {
			if (!file.endsWith(".ts")) continue;
			const src = readSource(join(AUDIT_DIR, file));
			const matches = src.match(/sendUserMessage/g);
			assert.ok(
				!matches || matches.length === 0,
				`pipeline/audit/${file} should contain no sendUserMessage references at all`,
			);
		}
	});

	it("no deliverAs reference anywhere in the audit package", () => {
		for (const file of readdirSync(AUDIT_DIR)) {
			if (!file.endsWith(".ts")) continue;
			const src = readSource(join(AUDIT_DIR, file));
			assert.ok(
				!src.includes("deliverAs"),
				`pipeline/audit/${file} should contain no deliverAs references`,
			);
		}
	});
});

// ===========================================================================
// Phase 2: CI failure path preserves behavior
// ===========================================================================

describe("pipeline/audit — CI failure path preserves behavior (Phase 2)", () => {
	it("CI failure path still has ctx.ui.notify call", () => {
		const src = readSource(PRE_GATES_TS);
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('ciResult.status === "failing"') + 500,
		);
		assert.ok(
			ciFailBlock.includes("deps.ui.notify"),
			"CI failure block should still contain ctx.ui.notify",
		);
	});

	it("CI failure path still gates the transition via a CI Gate section", () => {
		const src = readSource(PRE_GATES_TS);
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('ciResult.status === "failing"') + 500,
		);
		assert.ok(
			ciFailBlock.includes("--- CI Gate ---"),
			"CI failure should produce the CI Gate section",
		);
		// Orchestrator aggregates every gate failure
		const indexSrc = readSource(INDEX_TS);
		assert.ok(
			indexSrc.includes("gateFailures.push(ciGate.failureText)"),
			"orchestrator pushes CI gate failure",
		);
	});

	it("CI failure notification is warning type", () => {
		const src = readSource(PRE_GATES_TS);
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('ciResult.status === "failing"') + 500,
		);
		assert.ok(ciFailBlock.includes('"warning"'), "CI failure notify should use warning level");
	});

	it("CI failure notification mentions 'CI checks failing'", () => {
		const src = readSource(PRE_GATES_TS);
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('ciResult.status === "failing"') + 500,
		);
		assert.ok(
			ciFailBlock.includes("CI checks failing"),
			"CI failure notify should mention 'CI checks failing'",
		);
	});
});

// ===========================================================================
// Phase 3: TSC checkpoint failure path preserves behavior
// ===========================================================================

describe("pipeline/audit — TSC failure path preserves behavior (Phase 3)", () => {
	it("TSC failure path still has ctx.ui.notify call and produces a gate section", () => {
		const src = readSource(TSC_GATE_TS);
		// The catch block wraps runTscCheckpointFn failures
		const catchBlock = src.substring(
			src.indexOf("catch (tscErr: unknown)"),
			src.indexOf("catch (tscErr: unknown)") + 400,
		);
		assert.ok(catchBlock.includes("ctx.ui.notify"), "TSC catch block should contain ctx.ui.notify");
		assert.ok(catchBlock.includes(', "warning")'), "TSC failure notify should use warning level");

		// When tscDecision.nextStatus !== "Audit", the note block notifies and returns the section
		const noteBlock = src.substring(
			src.indexOf('if (tscDecision.nextStatus !== "Audit")'),
			src.indexOf('if (tscDecision.nextStatus !== "Audit")') + 300,
		);
		assert.ok(
			noteBlock.includes("ctx.ui.notify"),
			"TSC non-Audit block should contain ctx.ui.notify",
		);
		assert.ok(
			noteBlock.includes("--- TypeScript Checkpoint ---"),
			"TSC non-Audit block should produce the TypeScript Checkpoint section",
		);
	});

	it("TSC failure path still returns nextStatus from tscDecision via gateFailures", () => {
		const tscGateSrc = readSource(TSC_GATE_TS);
		const indexSrc = readSource(INDEX_TS);
		// The orchestrator returns Implementation when gates fail
		assert.ok(
			indexSrc.includes("gateFailures.push(tscFailure)"),
			"orchestrator pushes TSC gate failure",
		);
		// The gateFailures include TSC-specific information
		assert.ok(
			tscGateSrc.includes("--- TypeScript Checkpoint ---"),
			"TSC failure should add TypeScript Checkpoint section to gateFailures",
		);
	});

	it("TSC clean passes with info notify", () => {
		const src = readSource(TSC_GATE_TS);
		assert.ok(
			src.includes('ctx.ui.notify(tscDecision.note, "info")'),
			"TSC success notify should use info level",
		);
	});
});
