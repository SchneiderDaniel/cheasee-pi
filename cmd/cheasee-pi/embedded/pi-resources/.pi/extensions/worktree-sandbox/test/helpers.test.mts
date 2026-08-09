/**
 * Tests: test/helpers.ts — shared test utility module for worktree-sandbox
 *
 * Phase 1 of the duplicate code removal refactoring: validate each extracted
 * helper produces correct output in isolation, covering the three duplication
 * patterns (cross-file factories, try/finally env lifecycle, tool-triplicate).
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     .pi/extensions/worktree-sandbox/test/helpers.test.mts
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
	makePathEvent,
	makeToolCallEvent,
	makeCtx,
	makeMockPi,
	withSandboxEnv,
	assertBlocksOutside,
	assertPassesThrough,
} from "./helpers.ts";
import { join } from "node:path";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1a: makePathEvent
// ═══════════════════════════════════════════════════════════════════════

describe("makePathEvent", () => {
	it("returns { input: { path } } for a normal path", () => {
		const event = makePathEvent("/etc/passwd");
		assert.deepEqual(event, { input: { path: "/etc/passwd" } });
	});

	it("handles empty string", () => {
		const event = makePathEvent("");
		assert.deepEqual(event, { input: { path: "" } });
	});

	it("handles relative path", () => {
		const event = makePathEvent("relative/file.txt");
		assert.deepEqual(event, { input: { path: "relative/file.txt" } });
	});

	it("handles absolute path", () => {
		const event = makePathEvent("/tmp/sandbox-test-root");
		assert.deepEqual(event, { input: { path: "/tmp/sandbox-test-root" } });
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1b: makeToolCallEvent
// ═══════════════════════════════════════════════════════════════════════

describe("makeToolCallEvent", () => {
	it("returns a properly shaped tool call event", () => {
		const event = makeToolCallEvent("read", { path: "/etc/passwd" });
		assert.equal(event.type, "tool_call");
		assert.equal(event.toolCallId, "test-call-id");
		assert.equal(event.toolName, "read");
		assert.deepEqual(event.input, { path: "/etc/passwd" });
	});

	it("handles bash tool with command", () => {
		const event = makeToolCallEvent("bash", { command: "ls /etc" });
		assert.equal(event.toolName, "bash");
		assert.equal(event.input.command, "ls /etc");
	});

	it("handles write tool", () => {
		const event = makeToolCallEvent("write", { path: "/tmp/file" });
		assert.equal(event.toolName, "write");
	});

	it("handles edit tool", () => {
		const event = makeToolCallEvent("edit", { path: "/tmp/file" });
		assert.equal(event.toolName, "edit");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1c: makeCtx
// ═══════════════════════════════════════════════════════════════════════

describe("makeCtx", () => {
	it("returns default context when no overrides given", () => {
		const ctx = makeCtx();
		assert.equal(ctx.hasUI, false);
		assert.equal(ctx.mode, "tui");
		assert.equal(typeof ctx.ui.notify, "function");
		assert.ok(Array.isArray(ctx._notifications));
		assert.equal((ctx._notifications as Array<unknown>).length, 0);
		assert.equal(typeof ctx.isProjectTrusted, "function");
		assert.equal(ctx.isProjectTrusted!(), true);
	});

	it("returns hasUI true when overridden", () => {
		const ctx = makeCtx({ hasUI: true });
		assert.equal(ctx.hasUI, true);
	});

	it("returns mode print when overridden", () => {
		const ctx = makeCtx({ mode: "print" });
		assert.equal(ctx.mode, "print");
	});

	it("ui.notify pushes to _notifications array", () => {
		const ctx = makeCtx();
		ctx.ui.notify("test message", "warning");
		const notifications = ctx._notifications as Array<{ msg: string; level?: string }>;
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]!.msg, "test message");
		assert.equal(notifications[0]!.level, "warning");
	});

	it("ui.notify works without level argument", () => {
		const ctx = makeCtx();
		ctx.ui.notify("plain message");
		const notifications = ctx._notifications as Array<{ msg: string; level?: string }>;
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]!.msg, "plain message");
		assert.equal(notifications[0]!.level, undefined);
	});

	it("spreads overrides on top of defaults", () => {
		const ctx = makeCtx({ hasUI: true, mode: "print" });
		assert.equal(ctx.hasUI, true);
		assert.equal(ctx.mode, "print");
	});

	it("_notifications is fresh per call (not shared)", () => {
		const ctx1 = makeCtx();
		const ctx2 = makeCtx();
		ctx1.ui.notify("msg1");
		assert.equal((ctx1._notifications as Array<unknown>).length, 1);
		assert.equal((ctx2._notifications as Array<unknown>).length, 0);
	});

	it("_notifications is always present even when override has _notifications", () => {
		const ctx = makeCtx({ _notifications: "should-be-replaced" as unknown as Array<unknown> });
		assert.ok(Array.isArray(ctx._notifications));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1d: makeMockPi
// ═══════════════════════════════════════════════════════════════════════

describe("makeMockPi", () => {
	it("returns { on, handlers } where handlers is a Map", () => {
		const pi = makeMockPi();
		assert.equal(typeof pi.on, "function");
		assert.ok(pi.handlers instanceof Map);
	});

	it("on stores handler keyed by event name", () => {
		const pi = makeMockPi();
		const handler = async () => undefined;
		pi.on("tool_call", handler);
		assert.equal(pi.handlers.size, 1);
		assert.equal(pi.handlers.get("tool_call"), handler);
	});

	it("handlers are isolated per call", () => {
		const pi1 = makeMockPi();
		const pi2 = makeMockPi();
		pi1.on("tool_call", async () => undefined);
		assert.equal(pi1.handlers.size, 1);
		assert.equal(pi2.handlers.size, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1e: withSandboxEnv
// ═══════════════════════════════════════════════════════════════════════

describe("withSandboxEnv", () => {
	const ENV_KEY = "TEST_SANDBOX_PATH";

	after(() => {
		delete process.env[ENV_KEY];
	});

	it("sets process.env before fn, deletes after fn", async () => {
		await withSandboxEnv(ENV_KEY, "/tmp/test", async () => {
			assert.equal(process.env[ENV_KEY], "/tmp/test");
		});
		assert.equal(process.env[ENV_KEY], undefined);
	});

	it("returns the return value of fn", async () => {
		const result = await withSandboxEnv(ENV_KEY, "/tmp/test", async () => {
			return 42;
		});
		assert.equal(result, 42);
	});

	it("deletes env var in finally when fn throws", async () => {
		await assert.rejects(
			async () => {
				await withSandboxEnv(ENV_KEY, "/tmp/test", async () => {
					throw new Error("test error");
				});
			},
			{ message: "test error" },
		);
		assert.equal(process.env[ENV_KEY], undefined);
	});

	it("works with synchronous fn", async () => {
		await withSandboxEnv(ENV_KEY, "/tmp/test", () => {
			assert.equal(process.env[ENV_KEY], "/tmp/test");
		});
		assert.equal(process.env[ENV_KEY], undefined);
	});

	it("overwrites existing env value and restores to nothing", async () => {
		process.env[ENV_KEY] = "original";
		await withSandboxEnv(ENV_KEY, "override", async () => {
			assert.equal(process.env[ENV_KEY], "override");
		});
		assert.equal(process.env[ENV_KEY], undefined);
		// Note: this doesn't restore the original — aligned with test usage pattern
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1f: assertBlocksOutside (using a mock rewritePath)
// ═══════════════════════════════════════════════════════════════════════

describe("assertBlocksOutside", () => {
	const SANDBOX_ROOT = "/tmp/sandbox-test-root";

	it("asserts block for read with file operations noun", () => {
		const rewritePath = (
			_toolName: string,
			_event: { input: { path: string } },
			_sandboxRoot: string,
			_ctx: Record<string, unknown>,
			blockNoun: string,
		) => ({
			block: true,
			reason: `Path "/etc/passwd" is outside. All ${blockNoun} must stay within.`,
		});
		const ctx = makeCtx({ hasUI: false });

		// Should not throw
		assertBlocksOutside(
			rewritePath as Parameters<typeof assertBlocksOutside>[0],
			"read",
			"/etc/passwd",
			SANDBOX_ROOT,
			"file operations",
			ctx,
		);
	});

	it("asserts block for write with writes noun", () => {
		const rewritePath = (
			_toolName: string,
			_event: { input: { path: string } },
			_sandboxRoot: string,
			_ctx: Record<string, unknown>,
			blockNoun: string,
		) => ({
			block: true,
			reason: `All ${blockNoun} must stay within.`,
		});
		const ctx = makeCtx({ hasUI: false });

		assertBlocksOutside(
			rewritePath as Parameters<typeof assertBlocksOutside>[0],
			"write",
			"/etc/passwd",
			SANDBOX_ROOT,
			"writes",
			ctx,
		);
	});

	it("asserts block for edit with edits noun", () => {
		const rewritePath = (
			_toolName: string,
			_event: { input: { path: string } },
			_sandboxRoot: string,
			_ctx: Record<string, unknown>,
			blockNoun: string,
		) => ({
			block: true,
			reason: `All ${blockNoun} must stay within.`,
		});
		const ctx = makeCtx({ hasUI: false });

		assertBlocksOutside(
			rewritePath as Parameters<typeof assertBlocksOutside>[0],
			"edit",
			"/etc/passwd",
			SANDBOX_ROOT,
			"edits",
			ctx,
		);
	});

	it("throws when result is undefined (pass-through)", () => {
		const rewritePath = () => undefined;
		const ctx = makeCtx({ hasUI: false });

		assert.throws(() => {
			assertBlocksOutside(
				rewritePath as Parameters<typeof assertBlocksOutside>[0],
				"read",
				"/etc/passwd",
				SANDBOX_ROOT,
				"file operations",
				ctx,
			);
		}, /expected block result/);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1g: assertPassesThrough
// ═══════════════════════════════════════════════════════════════════════

describe("assertPassesThrough", () => {
	const SANDBOX_ROOT = "/tmp/sandbox-test-root";

	it("asserts pass-through for absolute path inside sandbox", () => {
		const rewritePath = () => undefined;
		const ctx = makeCtx({ hasUI: false });

		// Should not throw
		assertPassesThrough(
			rewritePath as Parameters<typeof assertPassesThrough>[0],
			"read",
			SANDBOX_ROOT,
			SANDBOX_ROOT,
			"file operations",
			ctx,
		);
	});

	it("asserts pass-through for relative path and verifies path mutation", () => {
		const rewritePath = (
			_toolName: string,
			event: { input: { path: string } },
			sandboxRoot: string,
			_ctx: Record<string, unknown>,
			_blockNoun: string,
		) => {
			event.input.path = join(sandboxRoot, event.input.path);
			return undefined;
		};
		const ctx = makeCtx({ hasUI: false });

		assertPassesThrough(
			rewritePath as Parameters<typeof assertPassesThrough>[0],
			"read",
			"relative/file.txt",
			SANDBOX_ROOT,
			"file operations",
			ctx,
		);
	});

	it("throws when result is a block", () => {
		const rewritePath = () => ({ block: true, reason: "blocked" });
		const ctx = makeCtx({ hasUI: false });

		assert.throws(() => {
			assertPassesThrough(
				rewritePath as Parameters<typeof assertPassesThrough>[0],
				"read",
				"/etc/passwd",
				SANDBOX_ROOT,
				"file operations",
				ctx,
			);
		}, /expected pass-through/);
	});
});
