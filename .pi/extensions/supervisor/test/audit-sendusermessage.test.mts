/**
 * Tests for audit.ts — sendUserMessage with deliverAs: "followUp" removal (Issue #604)
 *
 * Phase 1: Remove sendUserMessage calls from audit.ts
 * Phase 2: CI failure path preserves behavior (ctx.ui.notify, return value)
 * Phase 3: TSC checkpoint failure path preserves behavior (ctx.ui.notify, return value)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/audit-sendusermessage.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUDIT_TS = resolve(__dirname, "../pipeline/audit.ts");

function readAuditSource(): string {
	return readFileSync(AUDIT_TS, "utf-8");
}

// ===========================================================================
// Phase 1: Remove sendUserMessage calls from audit.ts
// ===========================================================================

describe("audit.ts — sendUserMessage removed (Phase 1)", () => {
	it("no sendUserMessage on CI failure path (was line 65)", () => {
		const src = readAuditSource();
		// Find the CI failure block
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('return { nextStatus: "Implementation"'),
		);
		// sendUserMessage should not appear in CI failure block
		assert.ok(
			!ciFailBlock.includes("sendUserMessage"),
			"CI failure block should not contain sendUserMessage",
		);
	});

	it("no sendUserMessage on TSC failure path (was line 131)", () => {
		const src = readAuditSource();
		// Find the TSC failure block
		const tscFailBlock = src.substring(
			src.indexOf('tscDecision.nextStatus !== "Audit"'),
			src.indexOf("return { nextStatus: tscDecision.nextStatus, note: tscDecision.note }"),
		);
		// sendUserMessage should not appear in TSC failure block
		assert.ok(
			!tscFailBlock.includes("sendUserMessage"),
			"TSC failure block should not contain sendUserMessage",
		);
	});

	it("entire file contains no pi.sendUserMessage call", () => {
		const src = readAuditSource();
		// Count all occurrences of sendUserMessage in the file
		const matches = src.match(/sendUserMessage/g);
		assert.ok(
			!matches || matches.length === 0,
			"audit.ts should contain no sendUserMessage references at all",
		);
	});

	it("no deliverAs reference exists in audit.ts", () => {
		const src = readAuditSource();
		assert.ok(!src.includes("deliverAs"), "audit.ts should contain no deliverAs references");
	});
});

// ===========================================================================
// Phase 2: CI failure path preserves behavior
// ===========================================================================

describe("audit.ts — CI failure path preserves behavior (Phase 2)", () => {
	it("CI failure path still has ctx.ui.notify call", () => {
		const src = readAuditSource();
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('ciResult.status === "failing"') + 500,
		);
		assert.ok(
			ciFailBlock.includes("ctx.ui.notify"),
			"CI failure block should still contain ctx.ui.notify",
		);
	});

	it("CI failure path still gates the transition via gateFailures", () => {
		const src = readAuditSource();
		// The function now uses gateFailures array pattern
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('ciResult.status === "failing"') + 500,
		);
		assert.ok(ciFailBlock.includes("gateFailures.push"), "CI failure should add to gateFailures");
		assert.ok(ciFailBlock.includes("--- CI Gate ---"), "CI failure should add CI Gate section");
	});

	it("CI failure notification is warning type", () => {
		const src = readAuditSource();
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('ciResult.status === "failing"') + 500,
		);
		assert.ok(ciFailBlock.includes('"warning"'), "CI failure notify should use warning level");
	});

	it("CI failure notification mentions 'CI checks failing'", () => {
		const src = readAuditSource();
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

describe("audit.ts — TSC failure path preserves behavior (Phase 3)", () => {
	it("TSC failure path still has ctx.ui.notify call and adds to gateFailures", () => {
		const src = readAuditSource();
		// The catch block wraps runTscCheckpointFn failures
		const catchBlock = src.substring(
			src.indexOf("catch (tscErr: unknown)"),
			src.indexOf("catch (tscErr: unknown)") + 400,
		);
		assert.ok(catchBlock.includes("ctx.ui.notify"), "TSC catch block should contain ctx.ui.notify");
		assert.ok(catchBlock.includes(', "warning")'), "TSC failure notify should use warning level");

		// When tscDecision.nextStatus !== "Audit", the note block notifies and adds to gateFailures
		const noteBlock = src.substring(
			src.indexOf('if (tscDecision.nextStatus !== "Audit")'),
			src.indexOf('if (tscDecision.nextStatus !== "Audit")') + 300,
		);
		assert.ok(
			noteBlock.includes("ctx.ui.notify"),
			"TSC non-Audit block should contain ctx.ui.notify",
		);
		assert.ok(noteBlock.includes("gateFailures.push"), "TSC non-Audit should add to gateFailures");
	});

	it("TSC failure path still returns nextStatus from tscDecision via gateFailures", () => {
		const src = readAuditSource();
		// The function returns nextStatus: "Implementation" when gates fail
		assert.ok(
			src.includes('nextStatus: "Implementation"'),
			"audit.ts should return Implementation when gates fail",
		);
		// The gateFailures include TSC-specific information
		assert.ok(
			src.includes("--- TypeScript Checkpoint ---"),
			"TSC failure should add TypeScript Checkpoint section to gateFailures",
		);
	});

	it("TSC clean passes with info notify", () => {
		const src = readAuditSource();
		assert.ok(
			src.includes('ctx.ui.notify(tscDecision.note, "info")'),
			"TSC success notify should use info level",
		);
	});
});
