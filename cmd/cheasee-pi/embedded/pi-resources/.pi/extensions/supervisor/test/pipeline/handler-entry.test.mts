// ─── Tests: pipeline/handler entry — dispatch characterization (issue #1395) ──
// Locks the pre-refactor entry contract through the shim import:
//   pipeline/handler.ts → handler/index.ts → runSupervisorPipeline.
// Trust gate, bad-args, --debug lifecycle, top-level catch and finally.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleSupervisorCommand } from "../../pipeline/handler.ts";
import { getDebugLogger, resetDebugLogger } from "../../lib/debug.ts";

interface NotifyCall {
	msg: string;
	level: string;
}

function createMockCtx(opts: { hasUI?: boolean; trusted?: boolean } = {}): {
	ctx: ExtensionCommandContext;
	notifyCalls: NotifyCall[];
	statusCalls: string[];
} {
	const hasUI = opts.hasUI ?? true;
	const notifyCalls: NotifyCall[] = [];
	const statusCalls: string[] = [];
	const ctx = {
		cwd: "/repo",
		hasUI,
		isProjectTrusted: () => opts.trusted ?? true,
		ui: {
			notify: (msg: string, level: string) => {
				notifyCalls.push({ msg, level });
			},
			setStatus: (_key: string, value: string | undefined) => {
				statusCalls.push(value === undefined ? "undefined" : value);
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifyCalls, statusCalls };
}

function createMockPi(
	opts: {
		/** Throw on the first non-null pi.events.emit call (the mid-pipeline
		 * issue-data payload emit). The finally's null emit must never throw:
		 * without a GH token createGitHubPort throws first, making the null
		 * emit the FIRST emit — and a throw in `finally` escapes try/catch
		 * (masking the original error). Payload-null exemption keeps the test
		 * deterministic with or without a token. */
		throwOnFirstEmit?: boolean;
		/** exec mock: return this for every call, or throw. */
		execResult?: { code: number; stdout: string; stderr: string } | Error;
	} = {},
): {
	pi: ExtensionAPI;
	sendMessages: Array<{ customType: string; content: string }>;
	emitted: unknown[];
	execCalls: string[][];
} {
	const sendMessages: Array<{ customType: string; content: string }> = [];
	const emitted: unknown[] = [];
	const execCalls: string[][] = [];
	let emitThrown = false;
	const pi = {
		exec: async (cmd: string, args: string[]) => {
			execCalls.push([cmd, ...args]);
			if (opts.execResult instanceof Error) throw opts.execResult;
			return opts.execResult ?? { code: 0, stdout: "{}", stderr: "" };
		},
		registerCommand: () => {},
		sendMessage: (m: { customType: string; content: string }) => {
			sendMessages.push(m);
		},
		events: {
			emit: (_name: string, payload: unknown) => {
				if (opts.throwOnFirstEmit && !emitThrown && payload !== null) {
					emitThrown = true;
					throw new Error("mock emit failure");
				}
				emitted.push(payload);
			},
		},
	} as unknown as ExtensionAPI;
	return { pi, sendMessages, emitted, execCalls };
}

beforeEach(() => {
	resetDebugLogger();
});

afterEach(() => {
	// No logger leak across invocations — every pipeline path must restore NOOP.
	resetDebugLogger();
});

describe("handler entry — project trust gate", () => {
	it("untrusted project → error notify, early return, zero config/GitHub/fs side effects", async () => {
		const { ctx, notifyCalls } = createMockCtx({ trusted: false });
		const { pi, sendMessages, emitted, execCalls } = createMockPi();

		await handleSupervisorCommand("42", ctx, pi);

		assert.equal(notifyCalls.length, 1);
		assert.equal(notifyCalls[0]!.msg, "Project not trusted. Skipping issue operations.");
		assert.equal(notifyCalls[0]!.level, "error");
		assert.equal(sendMessages.length, 0, "no sendMessage on trust-gate reject");
		assert.equal(emitted.length, 0, "no footer events on trust-gate reject");
		assert.equal(execCalls.length, 0, "no exec calls on trust-gate reject");
	});

	it("untrusted headless (hasUI=false) → ⚠️ sendMessage, no notify", async () => {
		const { ctx, notifyCalls } = createMockCtx({ hasUI: false, trusted: false });
		const { pi, sendMessages } = createMockPi();

		await handleSupervisorCommand("42", ctx, pi);

		assert.equal(notifyCalls.length, 0);
		assert.equal(sendMessages.length, 1);
		assert.ok(
			sendMessages[0]!.content.startsWith("⚠️ Project not trusted."),
			"headless trust-gate reject uses ⚠️ sendMessage",
		);
	});
});

describe("handler entry — arg parsing / invalid issue", () => {
	it("invalid issue number → usage notify, no loadConfig/port/worktree calls", async () => {
		const { ctx, notifyCalls, statusCalls } = createMockCtx();
		const { pi, execCalls, emitted } = createMockPi();

		await handleSupervisorCommand("abc", ctx, pi);

		assert.ok(
			notifyCalls.some((n) => n.msg === "Usage: /supervisor [--debug] <issue-number>"),
			"usage message notified",
		);
		assert.equal(execCalls.length, 0, "no exec calls before arg validation");
		assert.equal(statusCalls.length, 0, "no setStatus before arg validation");
		assert.equal(emitted.length, 0, "no footer events before arg validation");
	});

	it("--debug + invalid issue → debug logger reset back to NOOP (no leak)", async () => {
		const { ctx, notifyCalls } = createMockCtx();
		const { pi } = createMockPi();

		await handleSupervisorCommand("--debug abc", ctx, pi);

		assert.ok(
			notifyCalls.some((n) => n.msg === "Usage: /supervisor [--debug] <issue-number>"),
			"usage message notified",
		);
		assert.equal(getDebugLogger().getLogPath(), "", "getDebugLogger() back to NOOP after return");
	});

	it("no --debug → getDebugLogger() stays NOOP throughout", async () => {
		const { ctx } = createMockCtx();
		const { pi } = createMockPi();

		await handleSupervisorCommand("abc", ctx, pi);

		assert.equal(getDebugLogger().getLogPath(), "", "NOOP logger without --debug");
	});
});

describe("handler entry — --debug lifecycle with a valid issue", () => {
	it("--debug + valid issue → 'Debug logging enabled' at start, 'Debug log' in finally, NOOP after", async () => {
		const { ctx, notifyCalls } = createMockCtx();
		// exec throws on `gh issue view` → fetchIssue fails soft → early return
		// inside the try, finally still runs. (Without a GitHub token this same
		// test exercises the top-level catch instead — same entry contract.)
		const { pi } = createMockPi({ execResult: new Error("mock gh failure") });

		await handleSupervisorCommand("--debug 42", ctx, pi);

		const levels = notifyCalls.map((n) => n.level);
		assert.ok(
			notifyCalls.some((n) => n.level === "info" && n.msg.startsWith("Debug logging enabled → ")),
			"debug-enabled notification at start",
		);
		assert.ok(
			notifyCalls.some((n) => n.level === "info" && n.msg.startsWith("Debug log: ")),
			"debug log path notified in finally",
		);
		assert.ok(levels.includes("error"), "issue-not-found error surfaced");
		assert.equal(getDebugLogger().getLogPath(), "", "logger reset in finally");
	});
});

describe("handler entry — top-level catch + finally", () => {
	it("mid-pipeline throw → sendPipelineError notified, finally emits issue-data null", async () => {
		const { ctx, notifyCalls } = createMockCtx();
		// A thrown pi.events.emit after fetchIssue simulates a preflight error.
		// (Without a GitHub token, createGitHubPort throws earlier — same funnel.)
		const { pi, sendMessages, emitted } = createMockPi({ throwOnFirstEmit: true });

		await handleSupervisorCommand("42", ctx, pi);

		assert.ok(
			notifyCalls.some((n) => n.msg.startsWith("Supervisor error:")),
			"sendPipelineError notified on top-level catch",
		);
		assert.ok(sendMessages.length > 0, "error summary sent via sendMessage");
		// finally: issue-data cleared with null
		assert.equal(emitted.length, 1);
		assert.equal(emitted[0], null);
	});

	it("finally always emits supervisor:issue-data null (normal early-return path)", async () => {
		const { ctx } = createMockCtx();
		const { pi, emitted } = createMockPi({ execResult: new Error("mock gh failure") });

		await handleSupervisorCommand("42", ctx, pi);

		assert.equal(emitted.length, 1, "finally emits once");
		assert.equal(emitted[0], null);
	});
});

describe("handler entry — headless boundary (hasUI=false)", () => {
	it("valid issue, headless → resolves without throwing; no info-level notify calls", async () => {
		const { ctx, notifyCalls } = createMockCtx({ hasUI: false });
		const { pi } = createMockPi({ execResult: new Error("mock gh failure") });

		await handleSupervisorCommand("42", ctx, pi);

		assert.ok(
			!notifyCalls.some((n) => n.level === "info"),
			"info notifies degrade silently headless",
		);
	});
});
