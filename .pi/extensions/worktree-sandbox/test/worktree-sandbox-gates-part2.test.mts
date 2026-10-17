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
	describe("Phase 4: Integration — bash handler blocks unsafe commands", () => {
		it("safe cd src passes through", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "cd src" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			// Not blocked — command is rewritten
			assert.equal(result, undefined);
			assert.ok((event.input.command as string).startsWith('cd "' + sandboxDir + '" &&'));
		});

		it("blocks cd to /etc", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "cd /etc" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
			assert.ok((result.reason ?? "").includes("/etc"));
		});

		it("blocks cd with variable expansion $HOME", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "cd $HOME" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("blocks cd with command substitution", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "cd $(echo /etc)" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("blocks cd with tilde expansion", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "cd ~/escape" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("blocks cd piped from echo", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "echo hi | cd /etc" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("blocks bare cd", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "cd" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("blocks redirect to absolute path", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "echo hi > /etc/passwd" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("blocks cp with variable destination", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "cp a $DEST" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("blocks touch to absolute path", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "touch /etc/passwd" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("blocks tee multi-operand escape through the public handler", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", {
				command: "echo data | tee /etc/secret backup.txt",
			});
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
			assert.ok((result.reason ?? "").includes("outside the worktree"));
			assert.ok((result.reason ?? "").includes("/etc/secret"));
		});

		it("blocks touch non-last operand escape through the public handler", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", {
				command: `touch ${sandboxDir}/a /etc/b`,
			});
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});

		it("blocks bundled -t target-directory escape through the public handler", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", { command: "cp -at /etc/out src" });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
			assert.ok((result.reason ?? "").includes("outside the worktree"));
		});

		it("blocks glob tee operand escape through the public handler", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", {
				command: "echo data | tee /etc/* safe.txt",
			});
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
			assert.ok((result.reason ?? "").includes("outside the worktree"));
		});

		it("blocks glob target-directory escape through the public handler", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			for (const command of ["cp -t /etc/* src", "cp --target-directory=/etc/* src"]) {
				const event = makeToolCallEvent("bash", { command });
				const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
				const result = await handler(event, ctx);

				assert.ok(result !== undefined, `expected block for: ${command}`);
				assert.equal(result.block, true, `expected block for: ${command}`);
			}
		});

		it("blocks glob value-option escape through the public handler", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			for (const command of ["touch -r /etc/* ok.txt", "touch -mr /etc/[ab] ok.txt"]) {
				const event = makeToolCallEvent("bash", { command });
				const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
				const result = await handler(event, ctx);

				assert.ok(result !== undefined, `expected block for: ${command}`);
				assert.equal(result.block, true, `expected block for: ${command}`);
			}
		});

		it("blocks attached shell expansion on option tokens through the public handler", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			for (const command of [
				"cp -t$OUT src",
				"cp -at$OUT src",
				"install -t$OUT src",
				"touch -r$REF ok.txt",
				"c$X -t /etc/out src",
			]) {
				const event = makeToolCallEvent("bash", { command });
				const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
				const result = await handler(event, ctx);

				assert.ok(result !== undefined, `expected block for: ${command}`);
				assert.equal(result.block, true, `expected block for: ${command}`);
			}
		});

		it("allows tee with all operands inside sandbox", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const command = `echo data | tee ${sandboxDir}/a ${sandboxDir}/b`;
			const event = makeToolCallEvent("bash", { command });
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.equal(result, undefined);
			assert.equal(event.input.command, `cd "${sandboxDir}" && ${command}`);
		});

		it("blocks combined unsafe command at first cd", async () => {
			const pi = makeMockPi();
			mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
			const handler = pi.handlers.get("tool_call")!;

			const event = makeToolCallEvent("bash", {
				command: "echo hi | cd $HOME && echo data > $OUTFILE",
			});
			const ctx = makeCtx({ mode: "tui", isProjectTrusted: () => true });
			const result = await handler(event, ctx);

			assert.ok(result !== undefined);
			assert.equal(result.block, true);
		});
	});
});
