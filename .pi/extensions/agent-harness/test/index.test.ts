/**
 * Tests for AgentHarness — tool call validation class.
 *
 * Tests construct AgentHarness, call handleToolCall(), assert on return value.
 * No direct state access — only public API: handleToolCall(), handleTurnStart(), reset().
 * getBashSubKey stays as standalone pure function — tests for it remain here.
 *
 * Library-level unit tests (TimedMap, BashCommand, harness-state, harness-rules)
 * live in .pi/lib/*.test.ts — not duplicated here.
 *
 * @packageDocumentation
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { AgentHarness, getBashSubKey } from "../index.ts";
import type { ToolCallResult } from "../index.ts";
import agentHarness from "../index.ts";
import { CASCADE_THRESHOLD, CACHE_TTL_TURNS } from "../lib/harness-rules.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Helpers ──

function makeEvent(toolName: string, args: Record<string, unknown> = {}, isError = false) {
	return { toolName, input: args, isError };
}

function makeCtx() {
	return {};
}

function callNTimes(
	harness: AgentHarness,
	toolName: string,
	n: number,
	args: Record<string, unknown> = {},
): (ToolCallResult | null)[] {
	const results: (ToolCallResult | null)[] = [];
	for (let i = 0; i < n; i++) {
		results.push(harness.handleToolCall(makeEvent(toolName, args), makeCtx()));
	}
	return results;
}

// ── Basic pass-through ──

describe("AgentHarness — basic pass-through", () => {
	it("undefined toolName returns null", () => {
		assert.equal(new AgentHarness().handleToolCall({ input: {} }, makeCtx()), null);
	});

	it("empty toolName returns null", () => {
		assert.equal(new AgentHarness().handleToolCall(makeEvent(""), makeCtx()), null);
	});

	it("pass-through tools (structural_search, ripgrep_search, ask_user) pass through", () => {
		const h = new AgentHarness();
		for (const tool of ["structural_search", "ripgrep_search", "ask_user"]) {
			assert.equal(h.handleToolCall(makeEvent(tool, {}), makeCtx()), null, tool);
		}
	});

	it("bash simple commands (echo, npm test, ls) pass through", () => {
		const h = new AgentHarness();
		for (const cmd of ["echo hi", "npm test", "ls -la"]) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null, cmd);
		}
	});

	it("unknown tool does not crash", () => {
		assert.equal(
			new AgentHarness().handleToolCall(makeEvent("unknown_tool_xyz", {}), makeCtx()),
			null,
		);
	});

	it("bash empty/missing command passes through", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("bash", {}), makeCtx()), null);
		assert.equal(h.handleToolCall(makeEvent("bash", { command: "" }), makeCtx()), null);
	});
});

// ── Bash tool mismatch ──

describe("AgentHarness — bash tool mismatch", () => {
	it("standalone grep → block with redirectTo ripgrep_search", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("bash", { command: "grep foo" }),
			makeCtx(),
		);
		assert.ok(r?.block);
		assert.equal(r?.redirectTo, "ripgrep_search");
		assert.ok(r!.reason.includes("[SYSTEM OVERRIDE]"));
	});

	it("standalone cat → block with redirectTo read", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("bash", { command: "cat README.md" }),
			makeCtx(),
		);
		assert.ok(r?.block);
		assert.equal(r?.redirectTo, "read");
	});

	it("standalone head -5 file → pass through (head no longer in READ_CMDS)", () => {
		assert.equal(
			new AgentHarness().handleToolCall(makeEvent("bash", { command: "head -5 file" }), makeCtx()),
			null,
		);
	});

	it("standalone tail -10 file → block with redirectTo read", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("bash", { command: "tail -10 file" }),
			makeCtx(),
		);
		assert.ok(r?.block);
		assert.equal(r?.redirectTo, "read");
	});

	it("bash cat with redirect (cat > file) does NOT block", () => {
		for (const cmd of [
			"cat > /tmp/foo << EOF",
			"cat >> file << EOF",
			"cat file1.ts file2.ts > combined.ts",
		]) {
			assert.equal(
				new AgentHarness().handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()),
				null,
				cmd,
			);
		}
	});

	it("piped grep (ls | grep), chained (cd && rg), piped head pass through", () => {
		const h = new AgentHarness();
		for (const cmd of [
			"ls -la | grep foo",
			"cd src && rg pattern",
			"ls -la | head -5",
			"find . | xargs grep TODO",
		]) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null, cmd);
		}
	});

	it("quoted args (gh issue with grep/cat in title) do NOT block", () => {
		const h = new AgentHarness();
		for (const cmd of [
			"gh issue create --body '...| grep...'",
			'gh issue create --title "... cat ..."',
		]) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null, cmd);
		}
	});

	it("standalone gh issue with backtick grep in body passes through", () => {
		const h = new AgentHarness();
		assert.equal(
			h.handleToolCall(
				makeEvent("bash", { command: "gh issue create --body 'uses `grep` for search'" }),
				makeCtx(),
			),
			null,
		);
	});
});

// ── Error accumulation and retry blocking ──

describe("AgentHarness — error retry blocking", () => {
	it("single error passes through; 2 errors block next non-error call", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx()), null);
		assert.equal(h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx()), null);

		const r = h.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx());
		assert.ok(r?.block);
		assert.ok(r!.reason.includes("errored"));
	});

	it("different tools have independent error tracking", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());
		// write has no errors — should pass
		assert.equal(
			h.handleToolCall(makeEvent("write", { path: "c.ts", content: "" }), makeCtx()),
			null,
		);
	});

	it("turn_start decays errors — tool recovers after turn boundary", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());
		assert.ok(h.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx())?.block);

		h.handleTurnStart(); // decays 2→1
		assert.equal(h.handleToolCall(makeEvent("read", { path: "d.ts" }), makeCtx()), null);

		h.handleTurnStart(); // decays 1→0
		assert.equal(h.handleToolCall(makeEvent("read", { path: "e.ts" }), makeCtx()), null);
	});
});

// ── Read cache ──

describe("AgentHarness — read cache", () => {
	it("first read passes through; second read next turn same path+offset+limit blocks", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx()), null);

		// Advance to next session turn so same-turn bypass doesn't apply
		h.handleTurnStart();

		const r = h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.ok(r?.block);
		assert.ok(r!.reason.includes("cached"));
	});

	it("different paths or different offset/limit both pass", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts", offset: 0, limit: 100 }), makeCtx());

		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx()),
			null,
			"different path",
		);
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "a.ts", offset: 50, limit: 20 }), makeCtx()),
			null,
			"different offset/limit",
		);
	});

	it("read without path passes through (no caching)", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("read", {}), makeCtx()), null);
		assert.equal(h.handleToolCall(makeEvent("read", {}), makeCtx()), null);
	});

	it("cache miss after TTL expiry", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		// Advance sessionTurn past TTL via turn boundaries
		for (let i = 0; i < CACHE_TTL_TURNS; i++) {
			h.handleTurnStart();
		}
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx()), null);
	});
});

// ── Cache invalidation ──

describe("AgentHarness — cache invalidation", () => {
	it("write and edit tools clear read cache", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		h.handleToolCall(makeEvent("write", { path: "out.ts", content: "x" }), makeCtx());
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx()),
			null,
			"after write",
		);

		h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx());
		h.handleToolCall(
			makeEvent("edit", { path: "b.ts", oldText: "foo", newText: "bar" }),
			makeCtx(),
		);
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx()),
			null,
			"after edit",
		);
	});

	it("file-modifying bash (sed, echo >) clears read cache", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		h.handleToolCall(makeEvent("bash", { command: "sed -i 's/foo/bar/g' file.ts" }), makeCtx());
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx()),
			null,
			"after sed",
		);

		h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx());
		h.handleToolCall(makeEvent("bash", { command: "echo 'data' > /tmp/x" }), makeCtx());
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx()),
			null,
			"after echo >",
		);
	});

	it("non-modifying bash (ls) does NOT clear read cache", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		// Advance turn so same-turn bypass doesn't apply
		h.handleTurnStart();
		h.handleToolCall(makeEvent("bash", { command: "ls -la" }), makeCtx());
		assert.ok(h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx())?.block);
	});
});

// ── Cascade detection ──

describe("AgentHarness — cascade detection", () => {
	it("blocks at CASCADE_THRESHOLD consecutive same-tool calls", () => {
		const results = callNTimes(new AgentHarness(), "write", CASCADE_THRESHOLD, {
			path: "f.ts",
			content: "",
		});
		for (let i = 0; i < CASCADE_THRESHOLD - 1; i++) {
			assert.equal(results[i], null, `call ${i + 1} should pass`);
		}
		assert.ok(results[CASCADE_THRESHOLD - 1]?.block, `${CASCADE_THRESHOLD}th call should block`);
	});

	it("mixed tools do NOT trigger cascade", () => {
		const h = new AgentHarness();
		const sequence = [
			{ tool: "read", args: { path: "a.ts" } },
			{ tool: "bash", args: { command: "echo hi" } },
			{ tool: "read", args: { path: "b.ts" } },
			{ tool: "bash", args: { command: "echo there" } },
			{ tool: "read", args: { path: "c.ts" } },
			{ tool: "bash", args: { command: "echo world" } },
			{ tool: "read", args: { path: "d.ts" } },
			{ tool: "bash", args: { command: "echo foo" } },
		];
		for (let i = 0; i < sequence.length; i++) {
			const { tool, args } = sequence[i];
			assert.equal(h.handleToolCall(makeEvent(tool, args), makeCtx()), null, `step ${i} (${tool})`);
		}
	});

	it("pass-through tools (ask_user) never cascade — 15 consecutive pass", () => {
		const h = new AgentHarness();
		for (let i = 0; i < 15; i++) {
			assert.equal(
				h.handleToolCall(makeEvent("ask_user", { question: `Q${i}?` }), makeCtx()),
				null,
				`ask_user ${i}`,
			);
		}
	});

	it("read cascade is skipped (cache handles redundancy) — 8 different reads pass", () => {
		const h = new AgentHarness();
		for (let i = 0; i < 8; i++) {
			assert.equal(h.handleToolCall(makeEvent("read", { path: `file${i}.ts` }), makeCtx()), null);
		}
	});
});

// ── Cascade suggestion text ──

describe("AgentHarness — cascade suggestion text", () => {
	it("bash cascade WITHOUT && suggests combined bash calls", () => {
		const results = callNTimes(new AgentHarness(), "bash", 8, { command: "echo hi" });
		assert.ok(results[7]?.reason.includes("Combine bash calls with &&"));
	});

	it("bash cascade WITH && suggests reduce per-turn call count", () => {
		const results = callNTimes(new AgentHarness(), "bash", 8, {
			command: "cd /repo && git status",
		});
		assert.ok(results[7]?.reason.includes("Reduce per-turn call count"));
	});

	it("non-bash cascade suggests batch tool calls", () => {
		const results = callNTimes(new AgentHarness(), "write", 8, { path: "f.ts", content: "" });
		assert.ok(results[7]?.reason.includes("Batch write calls"));
	});
});

// ── Turn boundary cascade reset ──

describe("AgentHarness — turn boundary cascade reset", () => {
	it("8 same-tool calls in one turn — 8th blocked; turn_start resets for next turn", () => {
		const h = new AgentHarness();
		const results1 = callNTimes(h, "write", 8, { path: "f.ts", content: "" });
		assert.ok(results1[7]?.block, "8th call in turn 0 should block");

		h.handleTurnStart();

		const results2 = callNTimes(h, "write", 4, { path: "g.ts", content: "" });
		for (let i = 0; i < 4; i++) {
			assert.equal(results2[i], null, `turn 1 call ${i} should pass (reset)`);
		}
	});

	it("4 calls → turn_start → 4 calls — none blocked", () => {
		const h = new AgentHarness();
		for (let i = 0; i < 4; i++) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx()), null);
		}
		h.handleTurnStart();
		for (let i = 0; i < 4; i++) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx()), null);
		}
	});
});

// ── Blocked calls not recorded ──

describe("AgentHarness — blocked calls not recorded", () => {
	it("blocked bash grep does NOT inflate cascade counter", () => {
		const h = new AgentHarness();
		// Blocked by tool mismatch — not recorded
		h.handleToolCall(makeEvent("bash", { command: "cat README.md" }), makeCtx());
		// This should count as 1st legitimate call
		assert.equal(h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx()), null);
		// 6 more = 7 total legitimate (8th blocked)
		for (let i = 0; i < 6; i++) {
			h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx());
		}
		assert.ok(h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx())?.block);
	});

	it("blocked cache read -> different path read passes (counter not inflated)", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "test.ts" }), makeCtx());
		h.handleTurnStart();
		assert.ok(h.handleToolCall(makeEvent("read", { path: "test.ts" }), makeCtx())?.block);
		assert.equal(h.handleToolCall(makeEvent("read", { path: "other.ts" }), makeCtx()), null);
	});
});

// ── getBashSubKey pure function ──

describe("getBashSubKey", () => {
	it("2-token extraction for multi-verb CLIs", () => {
		assert.equal(getBashSubKey("git status"), "git status");
		assert.equal(getBashSubKey("npm install"), "npm install");
		assert.equal(getBashSubKey("docker ps"), "docker ps");
		assert.equal(getBashSubKey("gh issue list"), "gh issue");
	});

	it("single-token for simple commands", () => {
		assert.equal(getBashSubKey("echo hi"), "echo");
		assert.equal(getBashSubKey("ls -la"), "ls");
	});

	it("cd-prefix extraction", () => {
		assert.equal(getBashSubKey("cd /repo && git status"), "git status");
		assert.equal(getBashSubKey("cd /repo && ls"), "ls");
		assert.equal(getBashSubKey("cd /repo && gh issue view 271"), "gh issue");
		assert.equal(getBashSubKey("cd /repo"), "cd");
	});

	it("empty/whitespace returns undefined", () => {
		assert.equal(getBashSubKey(""), undefined);
		assert.equal(getBashSubKey("   "), undefined);
	});
});

// ── Multi-verb CLI diversity ──

describe("AgentHarness — multi-verb CLI diversity", () => {
	it("8 identical npm install calls — 8th blocked", () => {
		const results = callNTimes(new AgentHarness(), "bash", 8, { command: "npm install" });
		assert.ok(results[7]?.block);
	});

	it("diverse npm sub-commands — all pass", () => {
		const h = new AgentHarness();
		for (const cmd of ["npm install", "npm test", "npm run build", "npm publish"]) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null, cmd);
		}
	});

	it("diverse git sub-commands — all pass", () => {
		const h = new AgentHarness();
		for (const cmd of [
			"git status",
			"git diff",
			"git log",
			"git stash",
			"git branch",
			"git merge",
			"git push",
			"git pull",
		]) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null, cmd);
		}
	});

	it("bash subKey resets when switching between different first tokens", () => {
		const h = new AgentHarness();
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 4; i++) {
				const cmd = round === 1 ? "cd .." : "ls";
				assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null);
			}
		}
	});
});

// ── Reset ──

describe("AgentHarness — reset", () => {
	it("reset clears cascade state, error tracker, and read cache", () => {
		const h = new AgentHarness();

		// Build up cascade
		const results = callNTimes(h, "write", 8, { path: "f.ts", content: "" });
		assert.ok(results[7]?.block, "8th call should block");

		// Add errors
		h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());

		// Cache a read
		h.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx());

		// Reset
		h.reset();

		// All state should be fresh
		assert.equal(
			h.handleToolCall(makeEvent("write", { path: "fresh.ts", content: "" }), makeCtx()),
			null,
			"cascade cleared",
		);
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "d.ts" }), makeCtx()),
			null,
			"errors cleared",
		);
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx()),
			null,
			"cache cleared",
		);
	});
});

// ── Mock ExtensionAPI helper (top-level for reuse across describe blocks) ──

function createMockAPI() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const api = {
		handlers,
		on(event: any, handler: any) {
			handlers.set(event, handler);
		},
		fire(event: string, data: any, ctx?: any) {
			const handler = handlers.get(event);
			return handler ? handler(data, ctx ?? {}) : undefined;
		},
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off" as any,
		setThinkingLevel: () => {},
		registerProvider: () => {},
		unregisterProvider: () => {},
		events: { on: () => {}, emit: () => {}, off: () => {} } as any,
	};
	return api as typeof api & ExtensionAPI;
}

// ── Mock ExtensionAPI integration ──

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

// ── Phase 4: session_start wiring with config loading ──

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Track for cleanup
const configTempDirs: string[] = [];

function createConfigTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-wiring-test-"));
	configTempDirs.push(dir);
	fs.mkdirSync(path.join(dir, ".pi"));
	return dir;
}

function writeHarnessConfig(dir: string, content: unknown): void {
	fs.writeFileSync(path.join(dir, ".pi", "harness-config.json"), JSON.stringify(content), "utf-8");
}

function makeConfigCtx(overrides: Record<string, unknown> = {}) {
	return {
		isProjectTrusted: () => true,
		ui: {
			notify: () => {},
		},
		...overrides,
	};
}

describe("AgentHarness — session_start config loading", () => {
	const savedCwd = process.cwd();

	after(() => {
		// Restore cwd and clean up temp dirs
		process.chdir(savedCwd);
		for (const dir of configTempDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		configTempDirs.length = 0;
	});

	it("session_start with trusted ctx and config file present → resolved rules loaded, handleToolCall uses override cascade threshold", async () => {
		const dir = createConfigTempDir();
		writeHarnessConfig(dir, {
			toolMeta: { bash: { cascadeThreshold: 12 } },
			cascadeThreshold: 8,
		});
		process.chdir(dir);

		const api = createMockAPI();
		agentHarness(api);

		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());

		// 11 consecutive bash calls should pass (threshold 12)
		const results = [];
		for (let i = 0; i < 11; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "bash", input: { command: "echo hi" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		// 11th call should still be OK
		assert.equal(results[10], undefined, "11th bash call should pass (threshold 12)");

		// 12th call should block
		const blocked = await api.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "echo hi" } },
			makeConfigCtx(),
		);
		assert.ok(blocked?.block, "12th bash call should block");
	});

	it("session_start with untrusted ctx and config file present → defaults used, no config override applied", async () => {
		const dir = createConfigTempDir();
		writeHarnessConfig(dir, { cascadeThreshold: 99, toolMeta: { bash: { cascadeThreshold: 50 } } });
		process.chdir(dir);

		let notifyCalled = false;
		const api = createMockAPI();
		agentHarness(api);

		await api.fire(
			"session_start",
			{ type: "session_start", reason: "new" },
			makeConfigCtx({
				isProjectTrusted: () => false,
				ui: {
					notify: () => {
						notifyCalled = true;
					},
				},
			}),
		);

		assert.equal(notifyCalled, true, "should call notify for untrusted project");

		// Default threshold (8) should apply
		const results = [];
		for (let i = 0; i < 8; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "f.ts", content: "" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		for (let i = 0; i < 7; i++) {
			assert.equal(results[i], undefined, `call ${i + 1} should pass (default threshold)`);
		}
		assert.ok(results[7]?.block, "8th call should block (default threshold)");
	});

	it("session_start without config file → defaults used", async () => {
		const dir = createConfigTempDir();
		// No .pi/harness-config.json written
		process.chdir(dir);

		const api = createMockAPI();
		agentHarness(api);

		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());

		// Default threshold (8) should apply
		const results = [];
		for (let i = 0; i < 8; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "f.ts", content: "" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		for (let i = 0; i < 7; i++) {
			assert.equal(results[i], undefined, `call ${i + 1} should pass (default threshold)`);
		}
		assert.ok(results[7]?.block, "8th call should block (default threshold)");
	});

	it("session_start where config loader throws → session still initializes with defaults (fail-safe)", async () => {
		const dir = createConfigTempDir();
		// Malformed JSON config
		fs.writeFileSync(path.join(dir, ".pi", "harness-config.json"), "not valid json", "utf-8");
		process.chdir(dir);

		const api = createMockAPI();
		agentHarness(api);

		// Should not throw — catches error and falls back to defaults
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());

		// Default threshold (8) should still apply
		const results = [];
		for (let i = 0; i < 8; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "f.ts", content: "" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		for (let i = 0; i < 7; i++) {
			assert.equal(results[i], undefined, `call ${i + 1} should pass (default fallback)`);
		}
		assert.ok(results[7]?.block, "8th call should block (default fallback)");
	});

	it("Multiple session_start calls → each session_start reloads config independently", async () => {
		const dir1 = createConfigTempDir();
		writeHarnessConfig(dir1, { cascadeThreshold: 5 });

		const dir2 = createConfigTempDir();
		writeHarnessConfig(dir2, { cascadeThreshold: 3 });

		// First session with threshold 5
		process.chdir(dir1);

		const api = createMockAPI();
		agentHarness(api);

		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());

		// 4 calls should pass, 5th blocks
		let results = [];
		for (let i = 0; i < 5; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "f.ts", content: "" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		for (let i = 0; i < 4; i++) {
			assert.equal(results[i], undefined, `call ${i + 1} in session 1 should pass`);
		}
		assert.ok(results[4]?.block, "5th call in session 1 should block (threshold 5)");

		// Second session with threshold 3
		process.chdir(dir2);
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());

		// 2 calls should pass, 3rd blocks
		results = [];
		for (let i = 0; i < 3; i++) {
			const r = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "g.ts", content: "" } },
				makeConfigCtx(),
			);
			results.push(r);
		}
		for (let i = 0; i < 2; i++) {
			assert.equal(results[i], undefined, `call ${i + 1} in session 2 should pass`);
		}
		assert.ok(results[2]?.block, "3rd call in session 2 should block (threshold 3)");
	});
});
