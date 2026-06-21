/**
 * Tests for lib/tsc-types.ts — shared TypeScript type-check types and formatter.
 *
 * The formatTscDiagnostics function has been removed in favour of
 * formatDiagnostics from tsc-checkpoint/format.ts.
 *
 * This file now verifies the module still exports the expected types.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/tsc-types.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type {
	TscDiagnostic,
	TscCheckpointResult,
	TscCheckpointDecision,
} from "../../lib/tsc-types.ts";

describe("tsc-types module exports", () => {
	it("exports TscDiagnostic type", () => {
		// Type-only import verified at compile time
		const diag: TscDiagnostic = {
			file: "a.ts",
			line: 1,
			column: 1,
			severity: "Error",
			message: "msg",
			filePath: "/a.ts",
		};
		assert.strictEqual(diag.file, "a.ts");
	});

	it("exports TscCheckpointResult type", () => {
		const result: TscCheckpointResult = { diagnostics: [], hasErrors: false };
		assert.strictEqual(result.hasErrors, false);
	});

	it("exports TscCheckpointDecision type", () => {
		const decision: TscCheckpointDecision = {
			nextStatus: "Audit",
			note: "clean",
			tscTriggered: true,
		};
		assert.strictEqual(decision.nextStatus, "Audit");
	});
});
