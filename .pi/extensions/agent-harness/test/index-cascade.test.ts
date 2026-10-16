/**
 * AgentHarness — cascade detection, suggestion text, turn-boundary reset,
 * blocked-call recording, getBashSubKey and CLI diversity.
 *
 * Split from index.test.ts (issue #2005 Long File refactor).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentHarness, getBashSubKey } from "../index.ts";
import type { ToolCallResult, ResolvedHarnessRules } from "../index.ts";

import { CASCADE_THRESHOLD } from "../lib/harness-rules.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { makeEvent, makeCtx, callNTimes } from "./harness-fixtures.ts";

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

	it("unknown tool gets default batch advice", () => {
		const results = callNTimes(new AgentHarness(), "editor", 8, { path: "f.ts", content: "" });
		assert.ok(results[7]?.reason.includes("Batch editor calls to reduce turns"));
	});

	it("bash cascade with empty command suggests combined bash calls", () => {
		const results = callNTimes(new AgentHarness(), "bash", 8, { command: "" });
		assert.ok(results[7]?.reason.includes("Combine bash calls with && or use a script file"));
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
