/**
 * Tests for subagent status formatting and footer pipe separator.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/subagent-status.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { formatDuration, formatTokens } from "../lib/formatting.ts";

// ---------------------------------------------------------------------------
// Tests — formatTokens and formatDuration re-exports work
// ---------------------------------------------------------------------------

describe("formatting.ts re-exports", () => {
	it("formatTokens exports from formatting.ts", () => {
		assert.strictEqual(formatTokens(500), "500");
		assert.strictEqual(formatTokens(1500), "1.5K");
		assert.strictEqual(formatTokens(1_500_000), "1.5M");
	});

	it("formatDuration exports from formatting.ts", () => {
		assert.strictEqual(formatDuration(500), "500ms");
		assert.strictEqual(formatDuration(1500), "2s");
		assert.strictEqual(formatDuration(120_000), "2m 0s");
	});
});
