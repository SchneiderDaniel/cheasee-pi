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
	mockExecResponse,
	setMockResponses,
	resetMocks,
} from "./capture.ts";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: makeExecResult
// ═══════════════════════════════════════════════════════════════════════

describe("makeExecResult", () => {
	it("returns default ExecResult when called with no args", () => {
		const result = makeExecResult();
		assert.deepEqual(result, { stdout: "", stderr: "", code: 0, killed: false });
	});

	it("merges stdout override", () => {
		const result = makeExecResult({ stdout: "output" });
		assert.equal(result.stdout, "output");
		assert.equal(result.stderr, "");
		assert.equal(result.code, 0);
		assert.equal(result.killed, false);
	});

	it("merges code override", () => {
		const result = makeExecResult({ code: 1 });
		assert.equal(result.stdout, "");
		assert.equal(result.code, 1);
	});

	it("propagates killed flag", () => {
		const result = makeExecResult({ killed: true });
		assert.equal(result.killed, true);
	});

	it("includes stderr content", () => {
		const result = makeExecResult({ stderr: "error msg" });
		assert.equal(result.stderr, "error msg");
	});

	it("merges multiple overrides", () => {
		const result = makeExecResult({ stdout: "a", stderr: "b", code: 2, killed: true });
		assert.deepEqual(result, { stdout: "a", stderr: "b", code: 2, killed: true });
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: CapturedOutput
// ═══════════════════════════════════════════════════════════════════════

describe("CapturedOutput", () => {
	it("starts with empty arrays for all five fields", () => {
		const c = new CapturedOutput();
		assert.deepEqual(c.messages, []);
		assert.deepEqual(c.widgets, []);
		assert.deepEqual(c.statuses, []);
		assert.deepEqual(c.notifications, []);
		assert.deepEqual(c.execCalls, []);
	});

	it("captures message with customType, content, display, details", () => {
		const c = new CapturedOutput();
		c.messages.push({
			customType: "test-type",
			content: "hello",
			display: true,
			details: { key: "value" },
		});
		assert.equal(c.messages.length, 1);
		assert.equal(c.messages[0].customType, "test-type");
		assert.equal(c.messages[0].content, "hello");
		assert.equal(c.messages[0].display, true);
		assert.deepEqual(c.messages[0].details, { key: "value" });
	});

	it("captures message with options (triggerTurn, deliverAs)", () => {
		const c = new CapturedOutput();
		c.messages.push({
			customType: "type",
			content: "msg",
			display: true,
			triggerTurn: true,
			deliverAs: "steer",
		});
		assert.equal(c.messages[0].triggerTurn, true);
		assert.equal(c.messages[0].deliverAs, "steer");
	});

	it("captures widget with id and lines", () => {
		const c = new CapturedOutput();
		c.widgets.push({ id: "key", lines: ["line1", "line2"] });
		assert.equal(c.widgets.length, 1);
		assert.equal(c.widgets[0].id, "key");
		assert.deepEqual(c.widgets[0].lines, ["line1", "line2"]);
	});

	it("captures widget with undefined lines (clear case)", () => {
		const c = new CapturedOutput();
		c.widgets.push({ id: "key", lines: undefined });
		assert.equal(c.widgets[0].id, "key");
		assert.equal(c.widgets[0].lines, undefined);
	});

	it("captures status with key and text", () => {
		const c = new CapturedOutput();
		c.statuses.push({ key: "mykey", text: "ready" });
		assert.equal(c.statuses.length, 1);
		assert.equal(c.statuses[0].key, "mykey");
		assert.equal(c.statuses[0].text, "ready");
	});

	it("captures status with undefined text (clear case)", () => {
		const c = new CapturedOutput();
		c.statuses.push({ key: "mykey", text: undefined });
		assert.equal(c.statuses[0].text, undefined);
	});

	it("captures notification with msg and type", () => {
		const c = new CapturedOutput();
		c.notifications.push({ msg: "hello", type: "info" });
		assert.equal(c.notifications.length, 1);
		assert.equal(c.notifications[0].msg, "hello");
		assert.equal(c.notifications[0].type, "info");
	});

	it("captures exec call with cmd and args", () => {
		const c = new CapturedOutput();
		c.execCalls.push({ cmd: "gh", args: ["issue", "view", "123"] });
		assert.equal(c.execCalls.length, 1);
		assert.equal(c.execCalls[0].cmd, "gh");
		assert.deepEqual(c.execCalls[0].args, ["issue", "view", "123"]);
	});

	it("each captured array is independent per instance", () => {
		const c1 = new CapturedOutput();
		const c2 = new CapturedOutput();
		c1.messages.push({ customType: "a", content: "a" });
		assert.equal(c1.messages.length, 1);
		assert.equal(c2.messages.length, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Fixture Registry
// ═══════════════════════════════════════════════════════════════════════

describe("fixture registry", () => {
	beforeEach(() => {
		resetMocks();
	});

	it("mockExecResponse registers exact match; exec returns that result", async () => {
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);
		const expected = makeExecResult({ stdout: "issue body" });
		mockExecResponse("gh", ["issue", "view", "123"], expected);

		const result = await pi.exec("gh", ["issue", "view", "123"]);
		assert.equal(result.stdout, "issue body");
	});

	it("setMockResponses registers multiple fixtures", async () => {
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);
		setMockResponses({
			"gh issue view 123": makeExecResult({ stdout: "resultA" }),
			"gh pr create": makeExecResult({ stdout: "resultB" }),
		});

		const a = await pi.exec("gh", ["issue", "view", "123"]);
		const b = await pi.exec("gh", ["pr", "create"]);
		assert.equal(a.stdout, "resultA");
		assert.equal(b.stdout, "resultB");
	});

	it("unmatched command returns default error (code: 1)", async () => {
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);

		const result = await pi.exec("unknown", ["cmd"]);
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "");
	});

	it("resetMocks clears all registered fixtures", async () => {
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);
		mockExecResponse("gh", ["issue", "view", "123"], makeExecResult({ stdout: "data" }));
		resetMocks();

		const result = await pi.exec("gh", ["issue", "view", "123"]);
		assert.equal(result.code, 1, "after reset, exec should return default error");
	});

	it("wildcard fallback: ${cmd} * matches any args", async () => {
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);
		setMockResponses({
			"gh issue view *": makeExecResult({ stdout: "wildcard match" }),
		});

		const result = await pi.exec("gh", ["issue", "view", "999"]);
		assert.equal(result.stdout, "wildcard match");
	});

	it("exact match takes priority over wildcard", async () => {
		const captured = new CapturedOutput();
		const pi = createMockPi(captured);
		setMockResponses({
			"gh issue view *": makeExecResult({ stdout: "wildcard" }),
			"gh issue view 123": makeExecResult({ stdout: "exact" }),
		});

		const result = await pi.exec("gh", ["issue", "view", "123"]);
		assert.equal(result.stdout, "exact");
	});

	it("resetMocks after mockExecResponse leaves registry empty", async () => {
		mockExecResponse("git", ["status"], makeExecResult({ stdout: "clean" }));
		resetMocks();

		const captured = new CapturedOutput();
		const pi = createMockPi(captured);
		const result = await pi.exec("git", ["status"]);
		assert.equal(result.code, 1, "should fall back to default error after reset");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: createMockPi
// ═══════════════════════════════════════════════════════════════════════

describe("createMockPi", () => {
	let captured: CapturedOutput;
	let pi: ExtensionAPI;

	beforeEach(() => {
		resetMocks();
		captured = new CapturedOutput();
		pi = createMockPi(captured);
	});

	// use-case: satisfies ExtensionAPI type without as unknown as
	it("satisfies ExtensionAPI type (compile-time check)", () => {
		// This line must compile without `as any`:
		const _pi: ExtensionAPI = pi;
		assert.ok(_pi);
	});

	it("sendMessage pushes to captured.messages", () => {
		pi.sendMessage({ customType: "test", content: "hello", display: true });
		assert.equal(captured.messages.length, 1);
		assert.equal(captured.messages[0].customType, "test");
		assert.equal(captured.messages[0].content, "hello");
		assert.equal(captured.messages[0].display, true);
	});

	it("sendMessage captures options (triggerTurn)", () => {
		pi.sendMessage({ customType: "test", content: "hello", display: false }, { triggerTurn: true });
		assert.equal(captured.messages[0].triggerTurn, true);
	});

	it("sendMessage captures options (deliverAs)", () => {
		pi.sendMessage(
			{ customType: "test", content: "hello", display: false },
			{ deliverAs: "nextTurn" },
		);
		assert.equal(captured.messages[0].deliverAs, "nextTurn");
	});

	it("sendMessage captures details", () => {
		pi.sendMessage({ customType: "test", content: "hello", display: true, details: { x: 1 } });
		assert.deepEqual(captured.messages[0].details, { x: 1 });
	});

	it("exec pushes to captured.execCalls and returns registered fixture", async () => {
		mockExecResponse("git", ["status"], makeExecResult({ stdout: "clean" }));
		const result = await pi.exec("git", ["status"]);

		assert.equal(captured.execCalls.length, 1);
		assert.equal(captured.execCalls[0].cmd, "git");
		assert.deepEqual(captured.execCalls[0].args, ["status"]);
		assert.equal(result.stdout, "clean");
	});

	it("exec without registered fixture returns default error result (code: 1)", async () => {
		const result = await pi.exec("git", ["status"]);
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
	});

	it("events.emit is a no-op", () => {
		pi.events.emit("test", { data: 1 });
		// No throw is the assertion
		assert.ok(true);
	});

	it("events.on registers without error", () => {
		const unsub = pi.events.on("test", () => {});
		assert.equal(typeof unsub, "function");
		unsub();
	});

	it("exec with empty args works", async () => {
		const result = await pi.exec("gh", []);
		assert.equal(captured.execCalls.length, 1);
		assert.deepEqual(captured.execCalls[0].args, []);
		assert.equal(result.code, 1);
	});

	it("multiple calls accumulate in order", () => {
		pi.sendMessage({ customType: "a", content: "first", display: true });
		pi.sendMessage({ customType: "b", content: "second", display: false });
		assert.equal(captured.messages.length, 2);
		assert.equal(captured.messages[0].customType, "a");
		assert.equal(captured.messages[1].customType, "b");
	});

	// ══ All no-op methods do not throw ══
	it("registerCommand does not throw", () => {
		pi.registerCommand("test", { handler: async () => {} } as any);
	});

	it("registerTool does not throw", () => {
		pi.registerTool({} as any);
	});

	it("registerShortcut does not throw", () => {
		pi.registerShortcut("ctrl+a" as any, { handler: async () => {} });
	});

	it("registerFlag does not throw", () => {
		pi.registerFlag("verbose", { type: "boolean" });
	});

	it("getFlag returns undefined", () => {
		assert.equal(pi.getFlag("nonexistent"), undefined);
	});

	it("registerMessageRenderer does not throw", () => {
		pi.registerMessageRenderer("test", (() => {}) as any);
	});

	it("getActiveTools returns empty array", () => {
		assert.deepEqual(pi.getActiveTools(), []);
	});

	it("getAllTools returns empty array", () => {
		assert.deepEqual(pi.getAllTools(), []);
	});

	it("setActiveTools does not throw", () => {
		pi.setActiveTools([]);
	});

	it("sendUserMessage does not throw", () => {
		pi.sendUserMessage("hello");
	});

	it("appendEntry does not throw", () => {
		pi.appendEntry("test", { data: 1 });
	});

	it("setSessionName does not throw", () => {
		pi.setSessionName("test");
	});

	it("getSessionName returns undefined", () => {
		assert.equal(pi.getSessionName(), undefined);
	});

	it("setLabel does not throw", () => {
		pi.setLabel("entry-1", "label");
	});

	it("getCommands returns empty array", () => {
		assert.deepEqual(pi.getCommands(), []);
	});

	it("setModel resolves to true", async () => {
		const result = await pi.setModel({} as any);
		assert.equal(result, true);
	});

	it("getThinkingLevel returns 'off'", () => {
		assert.equal(pi.getThinkingLevel(), "off");
	});

	it("setThinkingLevel does not throw", () => {
		pi.setThinkingLevel("off" as any);
	});

	it("registerProvider does not throw", () => {
		pi.registerProvider("test", {} as any);
	});

	it("unregisterProvider does not throw", () => {
		pi.unregisterProvider("test");
	});

	it("executeTool returns default AgentRunResult fixture", async () => {
		const result = await (pi as any).executeTool("subagent", { agent: "test" });
		assert.ok(result);
		assert.equal(result.details.agentName, "mock-agent");
		assert.equal(result.details.success, true);
	});
});

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
