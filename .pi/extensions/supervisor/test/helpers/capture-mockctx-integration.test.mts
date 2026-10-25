/**
 * capture.test.mts — Tests for the shared capture harness (capture.ts).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/helpers/capture.test.mts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	CapturedOutput,
	createMockPi,
	createMockCtx,
	makeExecResult,
	setMockResponses,
	resetMocks,
} from "./capture.ts";

// Split from capture.test.mts (issue #2035 Long File refactor).
// ═══════════════════════════════════════════════════════════════════════
// Phase 5: createMockCtx
// ═══════════════════════════════════════════════════════════════════════

describe("createMockCtx", () => {
	let captured: CapturedOutput;
	let ctx: ExtensionCommandContext;

	beforeEach(() => {
		captured = new CapturedOutput();
		ctx = createMockCtx(captured);
	});

	it("satisfies ExtensionCommandContext type (compile-time check)", () => {
		const _ctx: ExtensionCommandContext = ctx;
		assert.ok(_ctx);
	});

	it("ui.setWidget pushes to captured.widgets", () => {
		ctx.ui.setWidget("key", ["line1"]);
		assert.equal(captured.widgets.length, 1);
		assert.equal(captured.widgets[0].id, "key");
		assert.deepEqual(captured.widgets[0].lines, ["line1"]);
	});

	it("ui.setWidget with undefined clears widget", () => {
		ctx.ui.setWidget("key", undefined);
		assert.equal(captured.widgets.length, 1);
		assert.equal(captured.widgets[0].id, "key");
		assert.equal(captured.widgets[0].lines, undefined);
	});

	it("ui.setStatus pushes to captured.statuses", () => {
		ctx.ui.setStatus("key", "text");
		assert.equal(captured.statuses.length, 1);
		assert.equal(captured.statuses[0].key, "key");
		assert.equal(captured.statuses[0].text, "text");
	});

	it("ui.setStatus with undefined clears status", () => {
		ctx.ui.setStatus("key", undefined);
		assert.equal(captured.statuses.length, 1);
		assert.equal(captured.statuses[0].key, "key");
		assert.equal(captured.statuses[0].text, undefined);
	});

	it("ui.notify pushes to captured.notifications", () => {
		ctx.ui.notify("hello", "info");
		assert.equal(captured.notifications.length, 1);
		assert.equal(captured.notifications[0].msg, "hello");
		assert.equal(captured.notifications[0].type, "info");
	});

	it("ui.theme.fg returns text unchanged (identity)", () => {
		const result = ctx.ui.theme.fg("dim", "some text");
		assert.equal(result, "some text");
	});

	it("cwd returns /repo by default", () => {
		assert.equal(ctx.cwd, "/repo");
	});

	it("cwd can be configured via options", () => {
		const ctx2 = createMockCtx(new CapturedOutput(), { cwd: "/custom" });
		assert.equal(ctx2.cwd, "/custom");
	});

	it("hasUI defaults to false", () => {
		assert.equal(ctx.hasUI, false);
	});

	it("hasUI can be set via options", () => {
		const ctx2 = createMockCtx(new CapturedOutput(), { hasUI: true });
		assert.equal(ctx2.hasUI, true);
	});

	it("signal defaults to undefined", () => {
		assert.equal(ctx.signal, undefined);
	});

	it("signal can be set via options", () => {
		const ac = new AbortController();
		const ctx2 = createMockCtx(new CapturedOutput(), { signal: ac.signal });
		assert.equal(ctx2.signal, ac.signal);
	});

	// ══ UI default methods do not throw ══

	it("ui.confirm returns true", async () => {
		const result = await ctx.ui.confirm("title", "msg");
		assert.equal(result, true);
	});

	it("ui.select returns undefined", async () => {
		const result = await ctx.ui.select("title", []);
		assert.equal(result, undefined);
	});

	it("ui.input returns undefined", async () => {
		const result = await ctx.ui.input("title");
		assert.equal(result, undefined);
	});

	it("ui.setFooter does not throw", () => {
		ctx.ui.setFooter(undefined as any);
	});

	it("ui.setHeader does not throw", () => {
		ctx.ui.setHeader(undefined as any);
	});

	it("ui.setTitle does not throw", () => {
		ctx.ui.setTitle("Test");
	});

	it("ui.pasteToEditor does not throw", () => {
		ctx.ui.pasteToEditor("text");
	});

	it("ui.setEditorText does not throw", () => {
		ctx.ui.setEditorText("text");
	});

	it("ui.getEditorText returns empty string", () => {
		assert.equal(ctx.ui.getEditorText(), "");
	});

	it("ui.editor returns undefined", async () => {
		const result = await ctx.ui.editor("title");
		assert.equal(result, undefined);
	});

	it("ui.onTerminalInput returns unsubscribe function", () => {
		const unsub = ctx.ui.onTerminalInput(() => {});
		assert.equal(typeof unsub, "function");
	});

	it("ui.setWorkingMessage does not throw", () => {
		ctx.ui.setWorkingMessage("loading");
	});

	it("ui.setWorkingVisible does not throw", () => {
		ctx.ui.setWorkingVisible(true);
	});

	it("ui.getToolsExpanded returns false", () => {
		assert.equal(ctx.ui.getToolsExpanded(), false);
	});

	it("ui.setToolsExpanded does not throw", () => {
		ctx.ui.setToolsExpanded(true);
	});

	it("ui.getAllThemes returns empty array", () => {
		assert.deepEqual(ctx.ui.getAllThemes(), []);
	});

	it("ui.getTheme returns undefined", () => {
		assert.equal(ctx.ui.getTheme("dark"), undefined);
	});

	it("ui.setTheme returns error", () => {
		const result = ctx.ui.setTheme("dark");
		assert.equal(result.success, false);
	});

	// ══ Context methods ══

	it("isIdle returns true", () => {
		assert.equal(ctx.isIdle(), true);
	});

	it("isProjectTrusted returns true", () => {
		assert.equal(ctx.isProjectTrusted(), true);
	});

	it("abort does not throw", () => {
		ctx.abort();
	});

	it("hasPendingMessages returns false", () => {
		assert.equal(ctx.hasPendingMessages(), false);
	});

	it("shutdown does not throw", () => {
		ctx.shutdown();
	});

	it("getContextUsage returns undefined", () => {
		assert.equal(ctx.getContextUsage(), undefined);
	});

	it("compact does not throw", () => {
		ctx.compact({} as any);
	});

	it("getSystemPrompt returns empty string", () => {
		assert.equal(ctx.getSystemPrompt(), "");
	});

	it("getSystemPromptOptions returns object with cwd", () => {
		const opts = ctx.getSystemPromptOptions();
		assert.equal(opts.cwd, "/repo");
	});

	it("waitForIdle resolves immediately", async () => {
		await ctx.waitForIdle();
	});

	it("newSession resolves with cancelled: false", async () => {
		const result = await ctx.newSession();
		assert.deepEqual(result, { cancelled: false });
	});

	it("fork resolves with cancelled: false", async () => {
		const result = await ctx.fork("entry-1");
		assert.deepEqual(result, { cancelled: false });
	});

	it("navigateTree resolves with cancelled: false", async () => {
		const result = await ctx.navigateTree("target-1");
		assert.deepEqual(result, { cancelled: false });
	});

	it("switchSession resolves without error", async () => {
		await ctx.switchSession("/sessions/other.json");
	});

	it("reload resolves without error", async () => {
		await ctx.reload();
	});

	it("mode returns 'print'", () => {
		assert.equal(ctx.mode, "print");
	});

	it("model is undefined", () => {
		assert.equal(ctx.model, undefined);
	});

	it("sessionManager has expected methods", () => {
		assert.equal(typeof ctx.sessionManager.getCwd, "function");
		assert.equal(typeof ctx.sessionManager.getSessionId, "function");
	});

	it("modelRegistry is present", () => {
		assert.ok(ctx.modelRegistry);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: Integration — harness components working together
// ═══════════════════════════════════════════════════════════════════════

describe("integration — harness components together", () => {
	it("createMockPi and createMockCtx share same captured instance", () => {
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);
		const ctx = createMockCtx(captured);

		pi.sendMessage({ customType: "pi", content: "from pi", display: true });
		ctx.ui.notify("from ctx", "warning");

		assert.equal(captured.messages.length, 1);
		assert.equal(captured.messages[0].content, "from pi");
		assert.equal(captured.notifications.length, 1);
		assert.equal(captured.notifications[0].msg, "from ctx");
	});

	it("mock pi exec delegates to fixture registry", async () => {
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);

		setMockResponses({
			"gh issue view 42": makeExecResult({ stdout: "the answer" }),
		});

		const result = await pi.exec("gh", ["issue", "view", "42"]);
		assert.equal(result.stdout, "the answer");
		assert.equal(captured.execCalls[0].cmd, "gh");
	});

	it("resetMocks in beforeEach clears registry; each test starts clean", async () => {
		resetMocks();
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);

		// No fixtures registered, should return default error
		const result = await pi.exec("any", ["cmd"]);
		assert.equal(result.code, 1);
	});

	it("two separate CapturedOutput instances do not share state", () => {
		const c1 = new CapturedOutput();
		const c2 = new CapturedOutput();
		const pi1 = createMockPi(c1);
		const pi2 = createMockPi(c2);

		pi1.sendMessage({ customType: "a", content: "one", display: true });
		pi2.sendMessage({ customType: "b", content: "two", display: false });

		assert.equal(c1.messages.length, 1);
		assert.equal(c2.messages.length, 1);
		assert.equal(c1.messages[0].content, "one");
		assert.equal(c2.messages[0].content, "two");
	});

	it("exec captured multiple calls preserves order", async () => {
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);

		await pi.exec("first", ["cmd"]);
		await pi.exec("second", ["cmd"]);

		assert.equal(captured.execCalls.length, 2);
		assert.equal(captured.execCalls[0].cmd, "first");
		assert.equal(captured.execCalls[1].cmd, "second");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 7: Migration compatibility
// ═══════════════════════════════════════════════════════════════════════

describe("migration compatibility", () => {
	it("ExecResult uses code (not exitCode), matching pi-coding-agent shape", () => {
		const result = makeExecResult({ code: 0 });
		assert.equal("code" in result, true);
		assert.equal("exitCode" in result, false);
	});

	it("exec returns standard ExecResult shape: { stdout, stderr, code, killed }", async () => {
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);
		const result = await pi.exec("test", []);
		assert.deepEqual(Object.keys(result).sort(), ["code", "killed", "stderr", "stdout"]);
	});
});
