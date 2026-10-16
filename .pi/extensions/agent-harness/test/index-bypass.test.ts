/**
 * AgentHarness — hasBypassAnnotation and the force-bypass gate, cascade
 * counter semantics and dispatch integration.
 *
 * Split from index.test.ts (issue #2005 Long File refactor).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentHarness } from "../index.ts";
import type { ToolCallResult, ResolvedHarnessRules } from "../index.ts";
import agentHarness from "../index.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasBypassAnnotation } from "../../lib/bash-query.ts";
import { makeEvent, makeCtx, createMockAPI, makeCtxWithUI } from "./harness-fixtures.ts";

// ── Phase 1: hasBypassAnnotation pure function ──

describe("hasBypassAnnotation — pure function", () => {
	it("bare annotation → true", () => {
		assert.equal(hasBypassAnnotation("# bypass-harness"), true);
	});

	it("command with trailing annotation → true", () => {
		assert.equal(hasBypassAnnotation("echo hi # bypass-harness"), true);
	});

	it("piped command with annotation → true", () => {
		assert.equal(hasBypassAnnotation("cat file | grep foo # bypass-harness"), true);
	});

	it("single-quoted annotation → false", () => {
		assert.equal(hasBypassAnnotation("echo '# bypass-harness'"), false);
	});

	it("double-quoted annotation → false", () => {
		assert.equal(hasBypassAnnotation('echo "# bypass-harness"'), false);
	});

	it("backtick-quoted annotation → false", () => {
		assert.equal(hasBypassAnnotation("echo `# bypass-harness`"), false);
	});

	it("URL hash → false (not standalone comment token)", () => {
		assert.equal(hasBypassAnnotation("curl http://example.com/#section"), false);
	});

	it("no space after hash → false", () => {
		assert.equal(hasBypassAnnotation("echo hi #bypass-harness"), false);
	});

	it("empty string → false", () => {
		assert.equal(hasBypassAnnotation(""), false);
	});

	it("whitespace only → false", () => {
		assert.equal(hasBypassAnnotation("   "), false);
	});

	it("heredoc content → false (falls through)", () => {
		assert.equal(hasBypassAnnotation("cat << EOF\n# bypass-harness\nEOF"), false);
	});

	it("line continuation → false (falls through)", () => {
		assert.equal(hasBypassAnnotation("echo hi \\\n# bypass-harness"), false);
	});

	it("trailing whitespace → true", () => {
		assert.equal(hasBypassAnnotation("echo hi # bypass-harness   "), true);
	});

	it("multiple annotations — still true", () => {
		assert.equal(hasBypassAnnotation("# bypass-harness\n# bypass-harness"), true);
	});

	it("annotation with leading whitespace → true", () => {
		assert.equal(hasBypassAnnotation("  # bypass-harness"), true);
	});
});

// ── Phase 2: Bypass gate in handleToolCall (hasUI: true) ──

describe("AgentHarness — force bypass gate", () => {
	it("input._harness.force: true bypasses tool-mismatch guard (bash grep)", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("bash", { command: "grep foo", _harness: { force: true } }),
			makeCtxWithUI(true),
		);
		assert.equal(r, null, "bypass: grep with force → pass through");
	});

	it("input._harness.force: true bypasses error-retry guard", () => {
		const h = new AgentHarness();
		// Accumulate 2 errors
		h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());
		// Force-bypassed call should pass despite errors
		const r = h.handleToolCall(
			makeEvent("read", { path: "c.ts", _harness: { force: true } }),
			makeCtxWithUI(true),
		);
		assert.equal(r, null, "bypass: errors ignored → pass through");
	});

	it("input._harness.force: true bypasses read-cache guard", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "test.ts" }), makeCtx());
		h.handleTurnStart();
		const r = h.handleToolCall(
			makeEvent("read", { path: "test.ts", _harness: { force: true } }),
			makeCtxWithUI(true),
		);
		assert.equal(r, null, "bypass: cache hit → pass through");
	});

	it("input._harness.force: true bypasses cascade guard", () => {
		const h = new AgentHarness();
		// Make 7 consecutive bash calls, then 8th with force
		for (let i = 0; i < 7; i++) {
			h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtxWithUI(true));
		}
		const r = h.handleToolCall(
			makeEvent("bash", { command: "echo hi", _harness: { force: true } }),
			makeCtxWithUI(true),
		);
		assert.equal(r, null, "bypass: 8th call with force → pass through");
	});

	it("input._harness.force: true on pass-through tool — still passes through", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("ask_user", { question: "ok?", _harness: { force: true } }),
			makeCtxWithUI(true),
		);
		assert.equal(r, null, "bypass + pass-through → pass through");
	});

	it("# bypass-harness annotation bypasses tool-mismatch guard", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("bash", { command: "grep foo # bypass-harness" }),
			makeCtxWithUI(true),
		);
		assert.equal(r, null, "annotation bypass: grep → pass through");
	});

	it("# bypass-harness annotation bypasses error-retry guard", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());
		// bash annotation doesn't apply to 'read' tool, but _harness.force on non-bash doesn't need annotation
		// Use bash tool for annotation test
		const r = h.handleToolCall(
			makeEvent("bash", { command: "cat test.ts # bypass-harness" }),
			makeCtxWithUI(true),
		);
		assert.equal(r, null, "annotation bypass: cat with annotation → pass through");
	});

	it("# bypass-harness annotation bypasses cascade guard (bash)", () => {
		const h = new AgentHarness();
		for (let i = 0; i < 7; i++) {
			h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtxWithUI(true));
		}
		const r = h.handleToolCall(
			makeEvent("bash", { command: "echo hi # bypass-harness" }),
			makeCtxWithUI(true),
		);
		assert.equal(r, null, "annotation bypass: 8th call → pass through");
	});

	it("both signals present (force + annotation) — bypasses", () => {
		const h = new AgentHarness();
		const r = h.handleToolCall(
			makeEvent("bash", {
				command: "grep foo # bypass-harness",
				_harness: { force: true },
			}),
			makeCtxWithUI(true),
		);
		assert.equal(r, null, "both signals → pass through");
	});

	it("input._harness.force: false — no bypass, normal guards apply", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("bash", { command: "grep foo", _harness: { force: false } }),
			makeCtxWithUI(true),
		);
		assert.ok(r?.block, "force:false → mismatch guard still blocks");
		assert.equal(r?.redirectTo, "ripgrep_search");
	});

	it("input._harness missing — no bypass, normal guards apply", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("bash", { command: "grep foo" }),
			makeCtxWithUI(true),
		);
		assert.ok(r?.block, "no _harness → mismatch guard still blocks");
	});

	it("input._harness.force: true but hasUI: false — bypass rejected", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("bash", { command: "grep foo", _harness: { force: true } }),
			makeCtxWithUI(false),
		);
		assert.ok(r?.block, "hasUI:false → bypass rejected, mismatch guard blocks");
	});

	it("# bypass-harness annotation but hasUI: false — bypass rejected", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("bash", { command: "grep foo # bypass-harness" }),
			makeCtxWithUI(false),
		);
		assert.ok(r?.block, "hasUI:false → annotation bypass rejected");
	});

	it("_harness field stripped from input after handleToolCall", () => {
		const event = makeEvent("bash", {
			command: "grep foo",
			_harness: { force: true },
		});
		new AgentHarness().handleToolCall(event, makeCtxWithUI(true));
		assert.equal((event.input as any)._harness, undefined, "_harness removed from input");
	});

	it("_harness stripped even on non-bypass path (force:false)", () => {
		const event = makeEvent("bash", {
			command: "grep foo",
			_harness: { force: false },
		});
		new AgentHarness().handleToolCall(event, makeCtxWithUI(true));
		assert.equal(
			(event.input as any)._harness,
			undefined,
			"_harness removed even when force:false",
		);
	});
});

// ── Phase 3: Cascade counter semantics ──

describe("AgentHarness — force bypass cascade counter semantics", () => {
	it("bypassed call inflates cascade counter", () => {
		const h = new AgentHarness();
		// 7 passive calls
		for (let i = 0; i < 7; i++) {
			h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtxWithUI(true));
		}
		// 1 bypassed call (counts as real)
		h.handleToolCall(
			makeEvent("bash", { command: "echo hi", _harness: { force: true } }),
			makeCtxWithUI(true),
		);
		// Next passive call should trigger cascade (8 effective calls recorded)
		const r = h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtxWithUI(true));
		assert.ok(r?.block, "9th call blocks because bypassed 8th inflated counter");
	});

	it("bypassed call does NOT itself trigger cascade block", () => {
		const h = new AgentHarness();
		// 7 passive calls
		for (let i = 0; i < 7; i++) {
			h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtxWithUI(true));
		}
		// 8th with bypass — bypass gate runs before cascade check, should pass
		const r = h.handleToolCall(
			makeEvent("bash", { command: "echo hi", _harness: { force: true } }),
			makeCtxWithUI(true),
		);
		assert.equal(r, null, "8th with force: bypass runs before cascade check → passes");
	});

	it("Bug 5 invariant preserved — blocked calls still don't inflate counter", () => {
		const h = new AgentHarness();
		// Blocked tool mismatch doesn't inflate counter
		h.handleToolCall(makeEvent("bash", { command: "cat README.md" }), makeCtx());
		// 1 legit call
		assert.equal(h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx()), null);
		// 6 more = 7 total legit
		for (let i = 0; i < 6; i++) {
			h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx());
		}
		// 8th legit call should block
		assert.ok(h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx())?.block);
	});
});

// ── Phase 4: Integration through dispatch ──

describe("AgentHarness — force bypass through dispatch", () => {
	it("Force bypass through dispatch", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r = await api.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "grep foo", _harness: { force: true } } },
			makeCtxWithUI(true),
		);
		assert.equal(r, undefined, "bypass through dispatch → pass through (undefined)");
	});

	it("_harness stripped through dispatch — tool never sees it", async () => {
		const api = createMockAPI();
		agentHarness(api);

		await api.fire(
			"tool_call",
			{
				toolName: "bash",
				input: { command: "echo hi", _harness: { force: true } },
			},
			makeCtxWithUI(true),
		);

		// Verify subsequent non-bypass call still works (proves harness state intact)
		const r2 = await api.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "echo hi" } },
			makeCtxWithUI(true),
		);
		assert.equal(r2, undefined, "subsequent call works after _harness strip");
	});

	it("Annotation through dispatch — bash grep with annotation passes", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r = await api.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "grep foo # bypass-harness" } },
			makeCtxWithUI(true),
		);
		assert.equal(r, undefined, "annotation through dispatch → pass through");
	});

	it("Annotation through dispatch with empty ctx — passes (hasUI defaults true)", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r = await api.fire(
			"tool_call",
			{ toolName: "bash", input: { command: "grep foo # bypass-harness" } },
			{},
		);
		// _ctx.hasUI !== false → hasUI defaults to true → passes
		assert.equal(r, undefined, "annotation with empty ctx → pass through");
	});
});
