/**
 * AgentHarness — extension entry point, mode-aware read cache, resolved-rules
 * cascade threshold and the #1725 preserved-public-exports regression.
 *
 * Split from index.test.ts (issue #2005 Long File refactor).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentHarness } from "../index.ts";
import type { ToolCallResult, ResolvedHarnessRules } from "../index.ts";
import agentHarness from "../index.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import * as fs from "node:fs";
import * as path from "node:path";

import { makeEvent, makeCtx, callNTimes, createMockAPI } from "./harness-fixtures.ts";

describe("AgentHarness — extension entry point", () => {
	it("registers session_start, turn_start, and tool_call handlers", () => {
		const api = createMockAPI();
		agentHarness(api);
		assert.ok(api.handlers.has("session_start"));
		assert.ok(api.handlers.has("turn_start"));
		assert.ok(api.handlers.has("tool_call"));
	});

	it("session_start resets cascade state", async () => {
		const api = createMockAPI();
		agentHarness(api);

		for (let i = 0; i < 9; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "write",
				input: { path: `file${i}.ts`, content: "" },
			});
			if (i >= 7) assert.ok(result?.block, `call ${i} should be blocked`);
			else assert.equal(result, undefined, `call ${i} should pass`);
		}

		await api.fire("session_start", { type: "session_start", reason: "new" });

		const after = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "reset",
			toolName: "write",
			input: { path: "fresh.ts", content: "" },
		});
		assert.equal(after, undefined, "after session_start, state should be fresh");
	});

	it("turn_start handler resets cascade — 8 across 2 turns bypasses block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		for (let i = 0; i < 4; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "bash",
				input: { command: "echo same" },
			});
			assert.equal(result, undefined, `turn 0 call ${i} should pass`);
		}

		await api.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

		for (let i = 0; i < 4; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(10 + i),
				toolName: "bash",
				input: { command: "echo same" },
			});
			assert.equal(result, undefined, `turn 1 call ${i} should pass (reset)`);
		}
	});

	it("read cache through dispatch works", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r1 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "read",
			input: { path: "test.ts" },
		});
		assert.equal(r1, undefined, "first read passes");

		// Advance to next session turn so same-turn bypass doesn't apply
		await api.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

		const r2 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "read",
			input: { path: "test.ts" },
		});
		assert.ok(r2?.block, "second read next turn blocks");
	});

	it("bash grep through dispatch", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "grep foo" },
		});
		assert.ok(r?.block);
	});

	it("undefined toolName in dispatch passes through and subsequent call works", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r1 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			input: { path: "x.ts" },
		});
		assert.equal(r1, undefined, "undefined toolName passes");

		const r2 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "read",
			input: { path: "a.ts" },
		});
		assert.equal(r2, undefined, "subsequent read passes");
	});
});

// ── Phase 3: Mode-aware read-cache bypass ──

describe("AgentHarness — mode-aware read cache", () => {
	it("hasUI: true, cache hit next turn → blocks with cached reason", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "test.ts" }), makeCtx());
		h.handleTurnStart();
		const r = h.handleToolCall(makeEvent("read", { path: "test.ts" }), {
			hasUI: true,
		} as any);
		assert.ok(r?.block);
		assert.ok(r!.reason.includes("cached"));
	});

	it("hasUI: false, cache hit → returns null (pass through)", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "test.ts" }), makeCtx());
		const r = h.handleToolCall(makeEvent("read", { path: "test.ts" }), {
			hasUI: false,
		} as any);
		assert.equal(r, null);
	});

	it("hasUI: undefined, cache hit next turn → blocks (backward compat)", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "test.ts" }), makeCtx());
		h.handleTurnStart();
		const r = h.handleToolCall(makeEvent("read", { path: "test.ts" }), {});
		assert.ok(r?.block);
	});

	it("hasUI: false, first read → passes through (normal cache store still happens)", () => {
		const h = new AgentHarness();
		const r = h.handleToolCall(makeEvent("read", { path: "test.ts" }), {
			hasUI: false,
		} as any);
		assert.equal(r, null, "first read passes");
		// Second read also passes (bypass in non-UI mode)
		const r2 = h.handleToolCall(makeEvent("read", { path: "test.ts" }), {
			hasUI: false,
		} as any);
		assert.equal(r2, null, "second read passes in non-UI mode");
	});

	it("hasUI: false but error retry (2+ errors) → still blocks (mode-independence for other guards)", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());
		const r = h.handleToolCall(makeEvent("read", { path: "c.ts" }), {
			hasUI: false,
		} as any);
		assert.ok(r?.block);
		assert.ok(r!.reason.includes("errored"));
	});

	it("hasUI: false but cascade threshold hit → still blocks (mode-independence for cascade)", () => {
		const results = callNTimes(new AgentHarness(), "write", 8, { path: "f.ts", content: "" });
		for (let i = 0; i < 7; i++) {
			assert.equal(results[i], null, `call ${i + 1} should pass`);
		}
		assert.ok(results[7]?.block, "8th call should block regardless of UI mode");
	});

	it("hasUI: false but tool mismatch (bash grep) → still blocks (mode-independence for mismatch)", () => {
		const h = new AgentHarness();
		const r = h.handleToolCall(makeEvent("bash", { command: "grep foo" }), {
			hasUI: false,
		} as any);
		assert.ok(r?.block);
		assert.equal(r?.redirectTo, "ripgrep_search");
	});

	it("hasUI on ctx, but ctx is empty object {} → blocks (backward compat via cast)", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "test.ts" }), {});
		h.handleTurnStart();
		const r = h.handleToolCall(makeEvent("read", { path: "test.ts" }), {});
		assert.ok(r?.block);
	});

	it("Mode context passed through dispatch via api.fire with hasUI: false → cache hit passes through", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r1 = await api.fire(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "1",
				toolName: "read",
				input: { path: "test.ts" },
			},
			{ hasUI: false },
		);
		assert.equal(r1, undefined, "first read passes in non-UI mode");

		const r2 = await api.fire(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "2",
				toolName: "read",
				input: { path: "test.ts" },
			},
			{ hasUI: false },
		);
		assert.equal(r2, undefined, "second read passes through (non-UI bypass)");
	});
});

// ── Phase 4: Config-overridden cascade threshold ──

describe("AgentHarness — resolved rules cascade threshold", () => {
	it("Config-overridden cascade threshold (e.g., bash threshold 12) → 11 consecutive bash calls pass, 12th blocked", () => {
		const h = new AgentHarness({
			toolMeta: { bash: { cascadeThreshold: 12 } },
			cascadeThreshold: 8,
		});
		const results = callNTimes(h, "bash", 12, { command: "echo hi" });
		for (let i = 0; i < 11; i++) {
			assert.equal(results[i], null, `call ${i + 1} should pass (threshold 12)`);
		}
		assert.ok(results[11]?.block, "12th call should block");
	});

	it("Default cascade threshold (8) still works without resolved rules", () => {
		const results = callNTimes(new AgentHarness(), "write", 8, {
			path: "f.ts",
			content: "",
		});
		for (let i = 0; i < 7; i++) {
			assert.equal(results[i], null, `call ${i + 1} should pass`);
		}
		assert.ok(results[7]?.block, "8th call should block");
	});
});

// ── Preserved public exports — issue #1725 regression ──

describe("AgentHarness — preserved public exports", () => {
	it("entry point re-exports loadProjectConfig and ResolvedHarnessRules; loader re-exports ToolMeta", async () => {
		const entry = await import("../index.ts");
		const loader = await import("../lib/load-config.ts");

		// Runtime: the entry-point re-export is the loader's function.
		assert.equal(entry.loadProjectConfig, loader.loadProjectConfig);
		// Type: ResolvedHarnessRules still resolves through the entry point.
		const rules: ResolvedHarnessRules = loader.loadDefaultRules();
		assert.equal(typeof rules.cascadeThreshold, "number");

		// Static: type-only re-exports cannot be asserted at runtime, so pin them in source.
		const entrySrc = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf-8");
		assert.match(entrySrc, /export type \{ ResolvedHarnessRules \} from "\.\/agent-harness\.ts";/);
		assert.match(entrySrc, /export \{ loadProjectConfig \} from "\.\/lib\/load-config\.ts";/);

		const loaderSrc = fs.readFileSync(
			path.join(import.meta.dirname, "..", "lib", "load-config.ts"),
			"utf-8",
		);
		assert.match(
			loaderSrc,
			/export type \{ ResolvedHarnessRules, ToolMeta \} from "\.\/harness-rules\.ts";/,
		);
	});
});
