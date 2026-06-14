// ─── Tests: message-renderer.ts — task prompt section in expanded view ──
// Phase 3: Renderer — task section in expanded view with 50-line truncation

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupervisorMessageDetails } from "../config/types.ts";
import { createMessageRenderer, createSummaryRenderer } from "../session/message-renderer.ts";
import { Container } from "@earendil-works/pi-tui";

// ─── Helpers ──────────────────────────────────────────────────────

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function makeMessage(details: SupervisorMessageDetails) {
	return { content: "", details };
}

/**
 * Get all rendered lines from a Container.
 */
function getLines(container: Container): string[] {
	return container.render(80);
}

// ─── Export reference tests (satisfy TDD gate: test-covers-symbols) ─

describe("message renderer — exports", () => {
	it("createMessageRenderer is a function", () => {
		assert.equal(typeof createMessageRenderer, "function");
	});

	it("createSummaryRenderer is a function", () => {
		assert.equal(typeof createSummaryRenderer, "function");
	});
});

// ─── Tests: Task section in expanded view ──────────────────────────

describe("message renderer — task prompt in expanded view", () => {
	it("expanded view with task prompt shows ── Task ── header and content", () => {
		const renderer = createMessageRenderer({} as any);
		const result = renderer(
			makeMessage({
				agentName: "test",
				success: true,
				statusLabel: "SUCCESS",
				toolCount: 0,
				tokenCount: 0,
				durationMs: 0,
				summaryLine: "",
				taskPrompt: "Build the feature",
			}),
			{ expanded: true },
			mockTheme,
		);
		assert.ok(result instanceof Container, "should return a Container");
		const container = result as Container;
		const lines = getLines(container);
		assert.ok(
			lines.some((l) => l.includes("── Task ──")),
			"should show Task header",
		);
		assert.ok(
			lines.some((l) => l.includes("Build the feature")),
			"should show task content",
		);
	});

	it("collapsed view with task prompt does NOT show ── Task ── header", () => {
		const renderer = createMessageRenderer({} as any);
		const result = renderer(
			makeMessage({
				agentName: "test",
				success: true,
				statusLabel: "SUCCESS",
				toolCount: 0,
				tokenCount: 0,
				durationMs: 0,
				summaryLine: "",
				taskPrompt: "Build the feature",
			}),
			{ expanded: false },
			mockTheme,
		);
		assert.ok(result instanceof Container, "should return a Container");
		const container = result as Container;
		const lines = getLines(container);
		assert.ok(
			!lines.some((l) => l.includes("── Task ──")),
			"should NOT show Task header in collapsed view",
		);
	});

	it("expanded view with undefined taskPrompt (old messages) does not crash, no Task header", () => {
		const renderer = createMessageRenderer({} as any);
		const result = renderer(
			makeMessage({
				agentName: "test",
				success: true,
				statusLabel: "SUCCESS",
				toolCount: 0,
				tokenCount: 0,
				durationMs: 0,
				summaryLine: "",
				taskPrompt: undefined,
			}),
			{ expanded: true },
			mockTheme,
		);
		assert.ok(result instanceof Container, "should return a Container");
		const container = result as Container;
		const lines = getLines(container);
		assert.ok(
			!lines.some((l) => l.includes("── Task ──")),
			"should NOT show Task header when taskPrompt is undefined",
		);
	});

	it("expanded view with empty string taskPrompt shows header only", () => {
		const renderer = createMessageRenderer({} as any);
		const result = renderer(
			makeMessage({
				agentName: "test",
				success: true,
				statusLabel: "SUCCESS",
				toolCount: 0,
				tokenCount: 0,
				durationMs: 0,
				summaryLine: "",
				taskPrompt: "",
			}),
			{ expanded: true },
			mockTheme,
		);
		assert.ok(result instanceof Container, "should return a Container");
		const container = result as Container;
		const lines = getLines(container);
		assert.ok(
			lines.some((l) => l.includes("── Task ──")),
			"should show Task header even when content is empty",
		);
	});

	it("task prompt of exactly 50 lines renders all lines without overflow notice", () => {
		const fiftyLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
		const renderer = createMessageRenderer({} as any);
		const result = renderer(
			makeMessage({
				agentName: "test",
				success: true,
				statusLabel: "SUCCESS",
				toolCount: 0,
				tokenCount: 0,
				durationMs: 0,
				summaryLine: "",
				taskPrompt: fiftyLines,
			}),
			{ expanded: true },
			mockTheme,
		);
		assert.ok(result instanceof Container, "should return a Container");
		const container = result as Container;
		const lines = getLines(container);
		// All 50 lines should be present
		for (let i = 1; i <= 50; i++) {
			assert.ok(
				lines.some((l) => l.includes(`line ${i}`)),
				`should contain line ${i}`,
			);
		}
		// No overflow notice
		assert.ok(
			!lines.some((l) => l.includes("more line")),
			"should NOT show overflow notice for exactly 50 lines",
		);
	});

	it("task prompt of 75 lines truncates to 50 with overflow notice", () => {
		const seventyFiveLines = Array.from({ length: 75 }, (_, i) => `line ${i + 1}`).join("\n");
		const renderer = createMessageRenderer({} as any);
		const result = renderer(
			makeMessage({
				agentName: "test",
				success: true,
				statusLabel: "SUCCESS",
				toolCount: 0,
				tokenCount: 0,
				durationMs: 0,
				summaryLine: "",
				taskPrompt: seventyFiveLines,
			}),
			{ expanded: true },
			mockTheme,
		);
		assert.ok(result instanceof Container, "should return a Container");
		const container = result as Container;
		const lines = getLines(container);
		// First 50 lines present
		assert.ok(
			lines.some((l) => l.includes("line 1")),
			"line 1 present",
		);
		assert.ok(
			lines.some((l) => l.includes("line 50")),
			"line 50 present",
		);
		// Line 51 NOT present (truncated)
		assert.ok(
			!lines.some((l) => l.includes("line 51")),
			"line 51 should NOT be present (truncated)",
		);
		// Overflow notice
		assert.ok(
			lines.some((l) => l.includes("… [25 more lines]")),
			"should show overflow notice: … [25 more lines]",
		);
	});

	it("task prompt of 51 lines shows overflow notice with singular", () => {
		const fiftyOneLines = Array.from({ length: 51 }, (_, i) => `line ${i + 1}`).join("\n");
		const renderer = createMessageRenderer({} as any);
		const result = renderer(
			makeMessage({
				agentName: "test",
				success: true,
				statusLabel: "SUCCESS",
				toolCount: 0,
				tokenCount: 0,
				durationMs: 0,
				summaryLine: "",
				taskPrompt: fiftyOneLines,
			}),
			{ expanded: true },
			mockTheme,
		);
		assert.ok(result instanceof Container, "should return a Container");
		const container = result as Container;
		const lines = getLines(container);
		assert.ok(
			lines.some((l) => l.includes("… [1 more line]")),
			"should show overflow notice: … [1 more line]",
		);
	});

	it("successful agent with task prompt still shows task section", () => {
		const renderer = createMessageRenderer({} as any);
		const result = renderer(
			makeMessage({
				agentName: "test",
				success: true,
				statusLabel: "SUCCESS",
				toolCount: 0,
				tokenCount: 0,
				durationMs: 0,
				summaryLine: "",
				taskPrompt: "Do something",
			}),
			{ expanded: true },
			mockTheme,
		);
		assert.ok(result instanceof Container, "should return a Container");
		const container = result as Container;
		const lines = getLines(container);
		assert.ok(
			lines.some((l) => l.includes("── Task ──")),
			"task section should render regardless of success status",
		);
		assert.ok(
			lines.some((l) => l.includes("Do something")),
			"task content should render",
		);
	});
});
