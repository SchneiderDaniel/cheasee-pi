/**
 * Tests for AgentHarness — tool call validation class.
 *
 * Tests construct AgentHarness, call handleToolCall(), assert on return value.
 * No direct state access — only public API: handleToolCall(), handleTurnStart(), reset().
 *
 * Split (issue #2005 Long File refactor): cascade/summary behaviour lives in
 * index-cascade.test.ts, extension wiring in index-entry.test.ts, config
 * loading in index-config.test.ts, the bypass gate in index-bypass.test.ts and
 * the annotation-derived defaults in index-dispatch.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentHarness } from "../index.ts";
import type { ToolCallResult, ResolvedHarnessRules } from "../index.ts";

import { CACHE_TTL_TURNS } from "../lib/harness-rules.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { makeEvent, makeCtx } from "./harness-fixtures.ts";

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

	it("standalone tail -10 file → passes through (tail -N is O(N) from EOF, read tool is O(file size))", () => {
		assert.equal(
			new AgentHarness().handleToolCall(makeEvent("bash", { command: "tail -10 file" }), makeCtx()),
			null,
		);
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

	it("bash grep/rg with a write redirect (save results to file) does NOT block (#1724)", () => {
		const h = new AgentHarness();
		for (const cmd of [
			"grep 'TODO' bigfile.ts > matches.txt",
			"grep foo>>out.txt",
			"rg pattern 2> err.txt",
			"grep foo &> out.txt",
			"cat file | grep foo > out.txt",
		]) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null, cmd);
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

	it("block message reports sessionTurn, not toolCallIndex", () => {
		const h = new AgentHarness();
		// Turn 0: two errors (toolCallIndex 0 and 1)
		h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());

		// Turn boundary: sessionTurn → 1, errors decay 2→1
		h.handleTurnStart();

		// Turn 1: one more error (toolCallIndex 2) → errors back to 2
		h.handleToolCall(makeEvent("read", { path: "c.ts" }, true), makeCtx());

		const r = h.handleToolCall(makeEvent("read", { path: "d.ts" }), makeCtx());
		assert.ok(r?.block);
		assert.ok(
			r!.reason.includes("last turn 1"),
			`expected \"last turn 1\" (session turn), got: ${r!.reason}`,
		);
	});

	it("multiple errors within one turn report the same session turn", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx()), null);
		assert.equal(h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx()), null);

		const r = h.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx());
		assert.ok(r?.block);
		assert.ok(r!.reason.includes("last turn 0"), r!.reason);
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
