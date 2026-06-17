/**
 * Tests verifying dead code removal for session-logger
 *
 * recoverMissingReports was dead code — defined and re-exported but never
 * called. The actual recovery logic lives in pipeline.ts::recoverPastSessions(),
 * which calls generateMissingReports directly.
 *
 * These tests verify the function is no longer exported after removal.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-dead-code.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

describe("recoverMissingReports dead code removal", () => {
	// After removal: importing recoverMissingReports from index.ts should fail
	// or the value should be undefined. Use dynamic import to check at runtime.
	it("should NOT be exported from index.ts (was dead code — pipeline.ts::recoverPastSessions handles recovery)", async () => {
		const mod = await import("../index.ts");
		const modAny = mod as Record<string, unknown>;
		assert.strictEqual(
			typeof modAny.recoverMissingReports,
			"undefined",
			"recoverMissingReports must be removed — pipeline.ts::recoverPastSessions handles recovery inline",
		);
	});

	// Confirm no collateral damage — generateMissingReports must still be exported
	it("generateMissingReports should still be exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof mod.generateMissingReports, "function");
	});
});

describe("beginSessionLoggerSession dead code removal", () => {
	it("should NOT be exported from index.ts (was dead code — use beginSession from pipeline.ts instead)", async () => {
		const mod = await import("../index.ts");
		const modAny = mod as Record<string, unknown>;
		assert.strictEqual(
			typeof modAny.beginSessionLoggerSession,
			"undefined",
			"beginSessionLoggerSession must be removed — use beginSession from pipeline.ts instead",
		);
	});

	it("beginSession should still be importable from pipeline.ts (surviving function, no regression)", async () => {
		const mod = await import("../pipeline.ts");
		assert.strictEqual(typeof mod.beginSession, "function");
	});
});
