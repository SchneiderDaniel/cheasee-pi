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
});
