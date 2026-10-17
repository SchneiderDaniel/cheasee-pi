import { describe, it, before, beforeEach, afterEach } from "node:test";

import assert from "node:assert/strict";

import { mkdtempSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { makeToolCallEvent, makeCtx, makeMockPi } from "./helpers.ts";

import type { ToolCallResult } from "./helpers.ts";

let mod: {
	default: (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void;
	rewritePath: (
		toolName: "read" | "write" | "edit",
		event: { input: { path: string } },
		sandboxRoot: string,
		ctx: {
			hasUI: boolean;
			ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
		},
		blockNoun: "file operations" | "writes" | "edits",
	) => ToolCallResult | undefined;
};

const ENV_KEY = "WORKTREE_SANDBOX_PATH";

let sandboxDir: string;

describe("worktree-sandbox gates", () => {
	before(async () => {
		mod = await import("../index.ts");
		// Create a temp directory that will serve as the sandbox root
		sandboxDir = mkdtempSync(join(tmpdir(), "sandbox-gate-test-"));
	});
	beforeEach(() => {
		// Ensure sandbox path is set for tests that reach getSandboxRoot()
		process.env[ENV_KEY] = sandboxDir;
	});
	afterEach(() => {
		delete process.env[ENV_KEY];
	});
	describe("exports", () => {
		it("exports rewritePath as a function", () => {
			assert.equal(typeof mod.rewritePath, "function");
		});

		it("exports default as a function (extension factory)", () => {
			assert.equal(typeof mod.default, "function");
		});

		it("rewritePath blocks absolute path outside sandbox when called directly", () => {
			const event = { input: { path: "/etc/passwd" } };
			const ctx = makeCtx({ hasUI: false });
			const result = mod.rewritePath(
				"read",
				event,
				"/tmp/sandbox-test-root",
				ctx,
				"file operations",
			);
			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("rewritePath allows relative path inside sandbox when called directly", () => {
			const event = { input: { path: "relative/file.txt" } };
			const ctx = makeCtx({ hasUI: false });
			const result = mod.rewritePath(
				"read",
				event,
				"/tmp/sandbox-test-root",
				ctx,
				"file operations",
			);
			assert.equal(result, undefined);
			assert.equal(event.input.path, join("/tmp/sandbox-test-root", "relative/file.txt"));
		});
	});
	describe("Phase 1: Trust gate — isProjectTrusted()", () => {
		it("isProjectTrusted() returns false → handler returns undefined for read tool", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({ isProjectTrusted: () => false, mode: "tui" });
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
		});

		it("isProjectTrusted() returns false → handler returns undefined for write tool", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("write", { path: "/etc/passwd" });
			const ctx = makeCtx({ isProjectTrusted: () => false, mode: "tui" });
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
		});

		it("isProjectTrusted() returns false → handler returns undefined for edit tool", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("edit", { path: "/etc/passwd" });
			const ctx = makeCtx({ isProjectTrusted: () => false, mode: "tui" });
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
		});

		it("isProjectTrusted() returns false → handler returns undefined for bash tool", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "ls /etc" });
			const ctx = makeCtx({ isProjectTrusted: () => false, mode: "tui" });
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
		});

		it("isProjectTrusted() returns undefined (old pi version) → handler proceeds to sandbox enforcement (backward compat)", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			// isProjectTrusted is undefined — should fall through to sandbox enforcement
			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({ isProjectTrusted: undefined, mode: "tui" });
			const result = await handler(event, ctx);

			// Sandbox should block this absolute path outside sandbox
			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("isProjectTrusted() returns false with hasUI=true → ctx.ui.notify called with warning", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const notifications: Array<{ msg: string; level?: string }> = [];
			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({
				hasUI: true,
				isProjectTrusted: () => false,
				mode: "tui",
				ui: {
					notify: (message: string, type?: string) => {
						notifications.push({ msg: message, level: type });
					},
				},
			});
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
			assert.equal(notifications.length, 1);
			assert.ok(notifications[0]!.msg.includes("[sandbox]"));
			assert.ok(notifications[0]!.msg.includes("not trusted"));
		});

		it("isProjectTrusted() returns false with hasUI=false → no notification sent", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const notifications: Array<{ msg: string; level?: string }> = [];
			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({
				hasUI: false,
				isProjectTrusted: () => false,
				mode: "tui",
				ui: {
					notify: (message: string, type?: string) => {
						notifications.push({ msg: message, level: type });
					},
				},
			});
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
			assert.equal(notifications.length, 0);
		});

		it("isProjectTrusted() returns true → sandbox still blocks path outside worktree (guard does not interfere)", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			// Path outside sandbox — should be blocked even when trusted
			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({ isProjectTrusted: () => true, mode: "tui" });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});
	});
	describe("Phase 2: Mode gate — ctx.mode", () => {
		it('mode is "print" → handler returns undefined before sandbox resolution', async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({ mode: "print", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
		});

		it('mode is "json" → handler returns undefined before sandbox resolution', async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({ mode: "json", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
		});

		it('mode is "tui" → handler proceeds to sandbox enforcement (normal operation)', async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			// Should reach sandbox enforcement and block the outside path
			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it('mode is "rpc" → handler proceeds to sandbox enforcement', async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({ mode: "rpc", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("mode is undefined (old pi version) → handler proceeds to sandbox enforcement (backward compat)", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({ mode: undefined, isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});
	});
	describe("Phase 2b: Both gates — mode gate takes precedence", () => {
		it("isProjectTrusted() returns false, mode is print → mode gate takes precedence, returns undefined", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({ isProjectTrusted: () => false, mode: "print" });
			const result = await handler(event, ctx);

			// Mode gate fires first, so sandbox is skipped even though project is untrusted
			assert.equal(result, undefined);
		});

		it("isProjectTrusted() returns true, mode is print → mode gate takes precedence, returns undefined", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("read", { path: "/etc/passwd" });
			const ctx = makeCtx({ isProjectTrusted: () => true, mode: "print" });
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
		});
	});
	describe("User journey: absolute `..` traversal confinement", () => {
		it("sub-agent read of escaped absolute path is blocked and notified", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const notifications: Array<{ msg: string; level?: string }> = [];
			const event = makeToolCallEvent("read", {
				path: `${sandboxDir}/../../../../etc/passwd`,
			});
			const ctx = makeCtx({
				hasUI: true,
				mode: "tui",
				isProjectTrusted: () => true,
				ui: {
					notify: (message: string, type?: string) => {
						notifications.push({ msg: message, level: type });
					},
				},
			});
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
			assert.ok((result.reason ?? "").includes("outside the worktree"));
			assert.equal(notifications.length, 1);
			assert.ok(notifications[0]!.msg.includes("Blocked read to outside worktree"));
		});

		it("sub-agent write with in-sandbox .. passes through and normalizes path", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("write", { path: `${sandboxDir}/sub/../note.txt` });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
			assert.equal(event.input.path, `${sandboxDir}/note.txt`);
		});
	});
});
