/**
 * AgentHarness — issue #1799 annotation-derived defaults, nested-call
 * attribution and tool-info provider wiring.
 *
 * Split from index.test.ts (issue #2005 Long File refactor).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentHarness } from "../index.ts";
import type { ToolCallResult, ResolvedHarnessRules } from "../index.ts";
import agentHarness from "../index.ts";
import { DESTRUCTIVE_CASCADE_THRESHOLD } from "../lib/harness-rules.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	makeEvent,
	makeCtx,
	callNTimes,
	createMockAPI,
	makeConfigCtx,
} from "./harness-fixtures.ts";

// ══════════════════════════════════════════════════════════════════
// Issue #1799: annotation-derived defaults + nested-call attribution
// ══════════════════════════════════════════════════════════════════

describe("AgentHarness — annotation-derived defaults", () => {
	it("read-only annotated tool is not error-tracked", () => {
		const h = new AgentHarness();
		h.setToolInfoProvider(() => [{ name: "read", annotations: { readOnlyHint: true } }]);
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx()), null);
		assert.equal(h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx()), null);
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx()),
			null,
			"third read passes — errors never accumulated",
		);
	});

	it("explicit config trackErrors:true overrides the read-only annotation", () => {
		const h = new AgentHarness({
			toolMeta: { read: { trackErrors: true } },
			cascadeThreshold: 8,
		});
		h.setToolInfoProvider(() => [{ name: "read", annotations: { readOnlyHint: true } }]);
		h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());
		assert.ok(h.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx())?.block);
	});

	it("destructive annotated tool escalates (tightens) the cascade threshold", () => {
		const h = new AgentHarness();
		h.setToolInfoProvider(() => [{ name: "danger", annotations: { destructiveHint: true } }]);
		const results = callNTimes(h, "danger", DESTRUCTIVE_CASCADE_THRESHOLD, {});
		for (let i = 0; i < DESTRUCTIVE_CASCADE_THRESHOLD - 1; i++) {
			assert.equal(results[i], null, `call ${i + 1} passes`);
		}
		assert.ok(results[DESTRUCTIVE_CASCADE_THRESHOLD - 1]?.block);
	});

	it("open-world annotated tool never loosens past the configured threshold", () => {
		const h = new AgentHarness();
		h.setToolInfoProvider(() => [{ name: "net", annotations: { openWorldHint: true } }]);
		const results = callNTimes(h, "net", 8, {});
		for (let i = 0; i < DESTRUCTIVE_CASCADE_THRESHOLD - 1; i++) {
			assert.equal(results[i], null, `call ${i + 1} passes`);
		}
		assert.ok(
			results[DESTRUCTIVE_CASCADE_THRESHOLD - 1]?.block,
			"blocks at the destructive default (4), never widens to 16",
		);
	});

	it("configured threshold stricter than the derived default is preserved", () => {
		const h = new AgentHarness({ toolMeta: {}, cascadeThreshold: 2 });
		h.setToolInfoProvider(() => [{ name: "danger", annotations: { destructiveHint: true } }]);
		const results = callNTimes(h, "danger", 2, {});
		assert.equal(results[0], null, "first call passes");
		assert.ok(results[1]?.block, "blocks at the configured 2, not the derived 4");
	});

	it("configured threshold looser than the derived default is tightened by min", () => {
		const h = new AgentHarness({ toolMeta: {}, cascadeThreshold: 12 });
		h.setToolInfoProvider(() => [{ name: "danger", annotations: { destructiveHint: true } }]);
		const results = callNTimes(h, "danger", DESTRUCTIVE_CASCADE_THRESHOLD, {});
		for (let i = 0; i < DESTRUCTIVE_CASCADE_THRESHOLD - 1; i++) {
			assert.equal(results[i], null, `call ${i + 1} passes`);
		}
		assert.ok(results[DESTRUCTIVE_CASCADE_THRESHOLD - 1]?.block, "min(12,4)=4");
	});

	it("explicit config toolMeta wins and the provider is not consulted", () => {
		const h = new AgentHarness({
			toolMeta: { net: { cascadeThreshold: 10 } },
			cascadeThreshold: 8,
		});
		let consulted = 0;
		h.setToolInfoProvider(() => {
			consulted++;
			return [{ name: "net", annotations: { destructiveHint: true } }];
		});
		const results = callNTimes(h, "net", 10, {});
		assert.equal(results[8], null, "9th call passes");
		assert.ok(results[9]?.block, "explicit cascadeThreshold 10 wins");
		assert.equal(consulted, 0, "explicitly-configured tool skips the provider");
	});

	it("hardcoded TOOL_META wins over provider annotations (web_crawl)", () => {
		const h = new AgentHarness();
		h.setToolInfoProvider(() => [{ name: "web_crawl", annotations: { openWorldHint: true } }]);
		const results = callNTimes(h, "web_crawl", 20, { url: "https://x" });
		assert.equal(results[18], null, "19th call passes");
		assert.ok(results[19]?.block, "hardcoded cascadeThreshold 20 wins");
	});

	it("empty annotations escalate to the MCP destructive default (min(8,4)=4)", () => {
		const h = new AgentHarness();
		h.setToolInfoProvider(() => [{ name: "mystery", annotations: {} }]);
		const results = callNTimes(h, "mystery", DESTRUCTIVE_CASCADE_THRESHOLD, {});
		for (let i = 0; i < DESTRUCTIVE_CASCADE_THRESHOLD - 1; i++) {
			assert.equal(results[i], null, `call ${i + 1} passes`);
		}
		assert.ok(results[DESTRUCTIVE_CASCADE_THRESHOLD - 1]?.block);
	});

	it("hardcoded passThrough is retained despite destructive annotations", () => {
		const h = new AgentHarness();
		h.setToolInfoProvider(() => [{ name: "ask_user", annotations: { destructiveHint: true } }]);
		for (let i = 0; i < 15; i++) {
			assert.equal(h.handleToolCall(makeEvent("ask_user", { question: `Q${i}` }), makeCtx()), null);
		}
	});

	it("unannotated provider tool keeps the conservative global threshold", () => {
		const h = new AgentHarness();
		h.setToolInfoProvider(() => [{ name: "mystery" }]);
		const results = callNTimes(h, "mystery", 8, {});
		for (let i = 0; i < 7; i++) assert.equal(results[i], null);
		assert.ok(results[7]?.block);
	});

	it("provider is consulted lazily on tool_call, not eagerly", () => {
		let calls = 0;
		const h = new AgentHarness();
		h.setToolInfoProvider(() => {
			calls++;
			return [{ name: "mystery" }];
		});
		assert.equal(calls, 0, "setting a provider performs no lookup");
		h.handleToolCall(makeEvent("ask_user", {}), makeCtx());
		assert.equal(calls, 0, "explicitly-configured tools skip the provider");
		h.handleToolCall(makeEvent("mystery", {}), makeCtx());
		assert.ok(calls >= 1, "unlisted tool triggers a lookup");
	});

	it("provider throw → fail-open, one warning, call passes", () => {
		const errors: unknown[][] = [];
		const originalError = console.error;
		console.error = (...a: unknown[]) => {
			errors.push(a);
		};
		try {
			const h = new AgentHarness();
			h.setToolInfoProvider(() => {
				throw new Error("annotation boom");
			});
			assert.equal(h.handleToolCall(makeEvent("mystery", {}), makeCtx()), null);
			assert.equal(h.handleToolCall(makeEvent("mystery", {}), makeCtx()), null);
		} finally {
			console.error = originalError;
		}
		assert.equal(errors.length, 1, "exactly one warning emitted");
		assert.ok(String(errors[0][0]).includes("annotation boom"));
	});

	it("provider absent → legacy behaviour unchanged", () => {
		const results = callNTimes(new AgentHarness(), "write", 8, { path: "f.ts", content: "" });
		assert.ok(results[7]?.block);
	});
});

describe("AgentHarness — nested call attribution", () => {
	function nested(
		toolName: string,
		toolCallId: string,
		parentToolCallId: string,
		args: Record<string, unknown> = {},
		isError = false,
	) {
		return { toolName, input: args, isError, toolCallId, parentToolCallId };
	}

	it("nested call mapped to an over-threshold parent is never blocked", () => {
		const h = new AgentHarness();
		for (let i = 0; i < 7; i++) {
			h.handleToolCall(
				{ toolName: "write", input: { path: `f${i}.ts`, content: "" }, toolCallId: `w${i}` },
				makeCtx(),
			);
		}
		const r = h.handleToolCall(nested("read", "w6/1", "w6", {}), makeCtx());
		assert.equal(r, null, "nested call never blocked by the parent's cascade state");
	});

	it("interleaved nested roll-ups count toward the parent's cascade threshold", () => {
		const h = new AgentHarness({
			toolMeta: { alpha: { cascadeThreshold: 3 } },
			cascadeThreshold: 8,
		});
		// parent alpha (p1), sibling beta interleaves, then a nested call under p1
		h.handleToolCall({ toolName: "alpha", input: {}, toolCallId: "p1" }, makeCtx());
		h.handleToolCall({ toolName: "beta", input: {}, toolCallId: "b1" }, makeCtx());
		h.handleToolCall(nested("read", "p1/1", "p1"), makeCtx());
		const r = h.handleToolCall({ toolName: "alpha", input: {} }, makeCtx());
		assert.ok(r?.block, "parent cascade includes the nested roll-up despite beta interleaving");
	});

	it("nested roll-up targets the parent's bash sub-key, not a sibling same-tool sub-key", () => {
		const h = new AgentHarness({
			toolMeta: { bash: { cascadeThreshold: 3 } },
			cascadeThreshold: 8,
		});
		// Parent A (p1) runs `git commit`; sibling B (p2) runs `npm test`.
		h.handleToolCall(
			{ toolName: "bash", input: { command: "git commit -m x" }, toolCallId: "p1" },
			makeCtx(),
		);
		h.handleToolCall(
			{ toolName: "bash", input: { command: "npm test" }, toolCallId: "p2" },
			makeCtx(),
		);
		// Nested call cites A's id — must roll up to `git commit`, not the latest sub-key.
		h.handleToolCall(nested("read", "p1/1", "p1"), makeCtx());

		const a = h.handleToolCall(
			{ toolName: "bash", input: { command: "git commit -m y" } },
			makeCtx(),
		);
		assert.ok(a?.block, "parent sub-key git commit includes its own nested roll-up");
		const b = h.handleToolCall({ toolName: "bash", input: { command: "npm test" } }, makeCtx());
		assert.equal(b, null, "sibling sub-key npm test is not inflated by the roll-up");
	});

	it("nested errors roll up and block the parent's next model call", () => {
		const h = new AgentHarness();
		h.handleToolCall(
			{ toolName: "write", input: { path: "a.ts", content: "" }, toolCallId: "p1" },
			makeCtx(),
		);
		h.handleToolCall(nested("read", "p1/1", "p1", {}, true), makeCtx());
		h.handleToolCall(nested("read", "p1/2", "p1", {}, true), makeCtx());
		const r = h.handleToolCall(makeEvent("write", { path: "b.ts", content: "" }), makeCtx());
		assert.ok(r?.block, "parent error block applies");
		assert.ok(r!.reason.includes("errored"));
	});

	it("nested errors under a read-only parent are not tracked (no error block)", () => {
		const h = new AgentHarness();
		h.setToolInfoProvider(() => [{ name: "read", annotations: { readOnlyHint: true } }]);
		h.handleToolCall({ toolName: "read", input: { path: "a.ts" }, toolCallId: "p1" }, makeCtx());
		h.handleToolCall(nested("read", "p1/1", "p1", {}, true), makeCtx());
		h.handleToolCall(nested("read", "p1/2", "p1", {}, true), makeCtx());
		const r = h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx());
		assert.equal(r, null, "read-only parent is never error-blocked by nested errors");
	});

	it("explicit config trackErrors:true restores nested error attribution for a read-only tool", () => {
		const h = new AgentHarness({
			toolMeta: { read: { trackErrors: true } },
			cascadeThreshold: 8,
		});
		h.setToolInfoProvider(() => [{ name: "read", annotations: { readOnlyHint: true } }]);
		h.handleToolCall({ toolName: "read", input: { path: "a.ts" }, toolCallId: "p1" }, makeCtx());
		h.handleToolCall(nested("read", "p1/1", "p1", {}, true), makeCtx());
		h.handleToolCall(nested("read", "p1/2", "p1", {}, true), makeCtx());
		const r = h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx());
		assert.ok(r?.block, "config trackErrors:true restores the nested error block");
	});

	it("unmapped parentToolCallId nested call passes and is counted nowhere", () => {
		const h = new AgentHarness();
		h.handleToolCall(nested("read", "ghost/1", "ghost", {}, true), makeCtx());
		h.handleToolCall(nested("read", "ghost/2", "ghost", {}, true), makeCtx());
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "x.ts" }), makeCtx()),
			null,
			"unmapped nested errors never roll up",
		);
	});

	it("nested write still clears the read cache", () => {
		const h = new AgentHarness();
		h.handleToolCall(
			{ toolName: "write", input: { path: "seed.ts", content: "" }, toolCallId: "p1" },
			makeCtx(),
		);
		h.handleToolCall({ toolName: "read", input: { path: "a.ts" }, toolCallId: "r1" }, makeCtx());
		h.handleTurnStart();
		h.handleToolCall(nested("write", "p1/1", "p1", { path: "b.ts", content: "" }), makeCtx());
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx()),
			null,
			"nested write invalidated the read cache",
		);
	});

	it("a late nested call under a non-active parent does not rewind the sibling's chain", () => {
		const h = new AgentHarness({
			toolMeta: { alpha: { cascadeThreshold: 3 }, beta: { cascadeThreshold: 3 } },
			cascadeThreshold: 8,
		});
		// alpha executes first (p1), then beta runs twice (b1, b2).
		h.handleToolCall({ toolName: "alpha", input: {}, toolCallId: "p1" }, makeCtx());
		h.handleToolCall({ toolName: "beta", input: {}, toolCallId: "b1" }, makeCtx());
		h.handleToolCall({ toolName: "beta", input: {}, toolCallId: "b2" }, makeCtx());
		// A's nested call lands late — it must not steal the active chain from beta.
		h.handleToolCall(nested("read", "p1/1", "p1"), makeCtx());
		const r = h.handleToolCall({ toolName: "beta", input: {} }, makeCtx());
		assert.ok(r?.block, "beta's third consecutive call still cascades at its threshold");
	});

	it("grandchild nested calls (depth ≥2) attribute to the root parent, not a same-named sibling counter", () => {
		const h = new AgentHarness();
		// A model-issued 'read' creates a counter entry under that name.
		h.handleToolCall({ toolName: "read", input: { path: "seed.ts" }, toolCallId: "r0" }, makeCtx());
		// Model-issued parent 'outer' issues a nested 'read', which issues grandchildren.
		h.handleToolCall({ toolName: "outer", input: {}, toolCallId: "p1" }, makeCtx());
		h.handleToolCall(nested("read", "p1/1", "p1", {}, true), makeCtx());
		h.handleToolCall(nested("leaf", "p1/1/1", "p1/1", {}, true), makeCtx());
		h.handleToolCall(nested("leaf", "p1/1/2", "p1/1", {}, true), makeCtx());

		const r = h.handleToolCall({ toolName: "outer", input: {} }, makeCtx());
		assert.ok(r?.block, "depth-2 nested errors roll up to the root parent 'outer'");
		assert.ok(r!.reason.includes("errored 3x"), "all nested errors counted against outer");
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "other.ts" }), makeCtx()),
			null,
			"the same-named 'read' counter is not polluted by foreign nested errors",
		);
	});
});

describe("AgentHarness — tool-info provider wiring", () => {
	it("session_start injects a provider; lookup stays lazy until tool_call", async () => {
		const api = createMockAPI();
		let calls = 0;
		(api as any).getAllTools = () => {
			calls++;
			return [];
		};
		agentHarness(api);
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());
		assert.equal(calls, 0, "no eager snapshot on session_start");
		await api.fire("tool_call", { toolName: "mystery", input: {} }, makeConfigCtx());
		assert.ok(calls >= 1, "provider consulted on tool_call");
	});

	it("feature-detect: pi.getAllTools missing → no throw, legacy behaviour", async () => {
		const api = createMockAPI();
		delete (api as any).getAllTools;
		agentHarness(api);
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());
		const results = [];
		for (let i = 0; i < 8; i++) {
			results.push(
				await api.fire(
					"tool_call",
					{ toolName: "write", input: { path: "f.ts", content: "" } },
					makeConfigCtx(),
				),
			);
		}
		assert.ok(results[7]?.block, "default threshold still applies");
	});

	it("read-only annotation flows through dispatch — no error block", async () => {
		const api = createMockAPI();
		(api as any).getAllTools = () => [{ name: "read", annotations: { readOnlyHint: true } }];
		agentHarness(api);
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());
		await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "a.ts" }, isError: true },
			makeConfigCtx(),
		);
		await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "b.ts" }, isError: true },
			makeConfigCtx(),
		);
		const r = await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "c.ts" } },
			makeConfigCtx(),
		);
		assert.equal(r, undefined, "third read passes");
	});

	it("nested calls flow through dispatch with parentToolCallId", async () => {
		const api = createMockAPI();
		agentHarness(api);
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());
		await api.fire(
			"tool_call",
			{ toolName: "write", input: { path: "a.ts", content: "" }, toolCallId: "p1" },
			makeConfigCtx(),
		);
		await api.fire(
			"tool_call",
			{ toolName: "read", input: {}, isError: true, toolCallId: "p1/1", parentToolCallId: "p1" },
			makeConfigCtx(),
		);
		await api.fire(
			"tool_call",
			{ toolName: "read", input: {}, isError: true, toolCallId: "p1/2", parentToolCallId: "p1" },
			makeConfigCtx(),
		);
		const r = await api.fire(
			"tool_call",
			{ toolName: "write", input: { path: "b.ts", content: "" } },
			makeConfigCtx(),
		);
		assert.ok(r?.block, "parent write blocked by rolled-up nested errors");
	});
});
