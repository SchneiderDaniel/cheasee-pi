// ─── Tests: message-renderer.ts — createMessageRenderer exports ──
// Tests that the module exports expected functions and integrates
// isToolCallLine for colorization.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMessageRenderer, createSummaryRenderer } from "../session/message-renderer.ts";
import { isToolCallLine } from "../event/session-events.ts";

// ─── Tests: Module exports ───────────────────────────────────────

describe("message-renderer exports", () => {
	it("exports createMessageRenderer as a function", () => {
		assert.equal(typeof createMessageRenderer, "function");
	});

	it("exports createSummaryRenderer as a function", () => {
		assert.equal(typeof createSummaryRenderer, "function");
	});
});

// ─── Tests: Colorization integration via isToolCallLine ───────────

describe("message-renderer colorization — isToolCallLine integration", () => {
	it("isToolCallLine is used for tool call detection in renderer", () => {
		// Verify isToolCallLine recognizes lines that the renderer would colorize
		assert.equal(isToolCallLine("$ npm test"), true);
		assert.equal(isToolCallLine("read /path/file.ts"), true);
		assert.equal(isToolCallLine("write /path/file.ts (45 lines)"), true);
		assert.equal(isToolCallLine("edit /path/file.ts"), true);
		assert.equal(isToolCallLine("grep /pattern/ in /src"), true);
		assert.equal(isToolCallLine("ls /home"), true);
		assert.equal(isToolCallLine("find /src"), true);
	});

	it("old-format 🔧 lines are NOT detected by isToolCallLine (handled by legacy color path)", () => {
		assert.equal(isToolCallLine("🔧 bash: npm test"), false);
		assert.equal(isToolCallLine("🔧 read: /path"), false);
	});

	it("isToolCallLine does NOT match result lines (keep emoji-based colorization)", () => {
		assert.equal(isToolCallLine("✓ read_file"), false);
		assert.equal(isToolCallLine("✗ read_file"), false);
		assert.equal(isToolCallLine("📋 read_file: output"), false);
	});

	it("isToolCallLine does NOT match thinking or context lines", () => {
		assert.equal(isToolCallLine("💭 thinking line"), false);
		assert.equal(isToolCallLine("📊 Context: 5.0K/10.0K"), false);
	});
});
