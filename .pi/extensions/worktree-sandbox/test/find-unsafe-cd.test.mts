/**
 * Tests: worktree-sandbox — findUnsafeCd function
 *
 * Tests the sandbox-escaping detection for `cd` commands.
 * findUnsafeCd is exported from index.ts as a seam for testing.
 *
 * ---- vv BOUNDARY: TDD GATE — do not remove vv ----
 * This test file imports findUnsafeCd from ../index.ts.
 * ---- ^^ BOUNDARY: TDD GATE — do not remove ^^ ----
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     .pi/extensions/worktree-sandbox/test/find-unsafe-cd.test.mts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- vv BOUNDARY: TDD GATE — do not remove vv ----
import { findUnsafeCd } from "../index.ts";
// ---- ^^ BOUNDARY: TDD GATE — do not remove ^^ ----

const SANDBOX_ROOT = "/tmp/sandbox-test-root";

describe("findUnsafeCd", () => {
	// ═════════════════════════════════════════════════════════════
	// Happy path: current behavior preserved
	// ═════════════════════════════════════════════════════════════

	it("returns null for cd to subdir inside sandbox (relative)", () => {
		const result = findUnsafeCd("cd subdir", SANDBOX_ROOT);
		assert.equal(result, null);
	});

	it("returns null for cd to absolute path inside sandbox", () => {
		const result = findUnsafeCd(`cd ${SANDBOX_ROOT}/path`, SANDBOX_ROOT);
		assert.equal(result, null);
	});

	it("returns '<previous-dir>' for cd - (previous dir, unresolvable at static analysis time)", () => {
		const result = findUnsafeCd("cd -", SANDBOX_ROOT);
		assert.equal(result, "<previous-dir>");
	});

	it("returns null for multiple safe cd commands in chain", () => {
		const result = findUnsafeCd("ls && cd subdir && pwd", SANDBOX_ROOT);
		assert.equal(result, null);
	});

	it("returns null when no cd command in input", () => {
		assert.equal(findUnsafeCd("ls -la", SANDBOX_ROOT), null);
		assert.equal(findUnsafeCd("echo hello", SANDBOX_ROOT), null);
	});

	// ═════════════════════════════════════════════════════════════
	// Bare cd — Scenario 1
	// ═════════════════════════════════════════════════════════════

	it("returns '<HOME>' for bare cd (no argument)", () => {
		const result = findUnsafeCd("cd", SANDBOX_ROOT);
		assert.equal(result, "<HOME>");
	});

	it("returns non-null for cd with trailing spaces", () => {
		const result = findUnsafeCd("cd  ", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "<HOME>");
	});

	it("returns non-null for bare cd in chain with &&", () => {
		const result = findUnsafeCd("ls && cd && pwd", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "<HOME>");
	});

	it("returns non-null for bare cd after semicolon", () => {
		const result = findUnsafeCd("cd; ls", SANDBOX_ROOT);
		assert.notEqual(result, null);
	});

	it("returns non-null for bare cd after OR separator", () => {
		const result = findUnsafeCd("cd || echo fail", SANDBOX_ROOT);
		assert.notEqual(result, null);
	});

	// ═════════════════════════════════════════════════════════════
	// Tilde expansion — Scenario 2
	// ═════════════════════════════════════════════════════════════

	it("returns non-null for cd ~", () => {
		const result = findUnsafeCd("cd ~", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "~");
	});

	it("returns non-null for cd ~/subdir", () => {
		const result = findUnsafeCd("cd ~/subdir", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "~/subdir");
	});

	it("returns non-null for cd ~otheruser", () => {
		const result = findUnsafeCd("cd ~otheruser", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "~otheruser");
	});

	// ═════════════════════════════════════════════════════════════
	// Variable expansion — Scenario 3
	// ═════════════════════════════════════════════════════════════

	it("returns non-null for cd $HOME", () => {
		const result = findUnsafeCd("cd $HOME", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "$HOME");
	});

	it("returns non-null for cd ${HOME}", () => {
		const result = findUnsafeCd("cd ${HOME}", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "${HOME}");
	});

	it("returns non-null for cd $HOME/subdir", () => {
		const result = findUnsafeCd("cd $HOME/subdir", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "$HOME/subdir");
	});

	it("returns non-null for cd $PWD (any variable)", () => {
		const result = findUnsafeCd("cd $PWD", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "$PWD");
	});

	// ═════════════════════════════════════════════════════════════
	// Backtick command substitution
	// ═════════════════════════════════════════════════════════════

	it("returns non-null for cd `pwd` (backticks)", () => {
		const result = findUnsafeCd("cd `pwd`", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "`pwd`");
	});

	// ═════════════════════════════════════════════════════════════
	// Shell expansion chars in multi-command chains
	// ═════════════════════════════════════════════════════════════

	it("returns null when tilde is in non-cd word (echo ~)", () => {
		const result = findUnsafeCd(`echo ~ && cd ${SANDBOX_ROOT}/safe`, SANDBOX_ROOT);
		assert.equal(result, null);
	});

	it("returns null when $VAR is in non-cd word (echo $HOME)", () => {
		const result = findUnsafeCd(`cd ${SANDBOX_ROOT}/safe && echo $HOME`, SANDBOX_ROOT);
		assert.equal(result, null);
	});

	// ═════════════════════════════════════════════════════════════
	// Existing blocked paths (preserved behavior)
	// ═════════════════════════════════════════════════════════════

	it("returns non-null for cd /etc (absolute outside sandbox)", () => {
		const result = findUnsafeCd("cd /etc", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "/etc");
	});

	it("returns non-null for cd ../../outside (relative path escape)", () => {
		const result = findUnsafeCd("cd ../../outside", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "../../outside");
	});

	it("returns non-null for cd / (filesystem root)", () => {
		const result = findUnsafeCd("cd /", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "/");
	});

	// ═════════════════════════════════════════════════════════════
	// Boundary / edge cases
	// ═════════════════════════════════════════════════════════════

	it("returns null for empty string", () => {
		const result = findUnsafeCd("", SANDBOX_ROOT);
		assert.equal(result, null);
	});

	it("returns null for whitespace-only string", () => {
		const result = findUnsafeCd("   ", SANDBOX_ROOT);
		assert.equal(result, null);
	});

	it("returns null for cd to sandbox root itself", () => {
		const result = findUnsafeCd(`cd ${SANDBOX_ROOT}`, SANDBOX_ROOT);
		assert.equal(result, null);
	});

	it("returns null for cd to absolute path inside sandbox (subdir)", () => {
		const result = findUnsafeCd(`cd ${SANDBOX_ROOT}/subdir`, SANDBOX_ROOT);
		assert.equal(result, null);
	});

	it('returns non-null for cd "~" (quoted tilde — conservative block, false positive risk accepted)', () => {
		const result = findUnsafeCd('cd "~"', SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, '"~"');
	});

	it("returns non-null for cd \\$HOME (escaped dollar — conservative block, false positive risk accepted)", () => {
		const result = findUnsafeCd("cd \\$HOME", SANDBOX_ROOT);
		assert.notEqual(result, null);
		assert.equal(result, "\\$HOME");
	});

	it("returns non-null for cd '${HOME}' (single-quoted — conservative block, false positive risk accepted)", () => {
		const result = findUnsafeCd("cd '${HOME}'", SANDBOX_ROOT);
		assert.notEqual(result, null);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Bash handler integration tests
// ═══════════════════════════════════════════════════════════════════════

describe("findUnsafeCd via bash handler (integration)", () => {
	// Use minimal types for Node.js --experimental-strip-types compatibility
	let handler: Function;
	let sandboxDir: string;

	before(async () => {
		// Create a real temp directory — getSandboxRoot() checks existsSync()
		sandboxDir = mkdtempSync(join(tmpdir(), "sandbox-int-test-"));

		// Load the default extension factory and register a mock pi
		const mod = await import("../index.ts");
		const handlers = new Map();
		const pi = {
			on: (event: string, h: Function) => {
				handlers.set(event, h);
			},
		};
		mod.default(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);
		handler = handlers.get("tool_call");
	});

	after(() => {
		// Clean up the temp directory
		try {
			rmSync(sandboxDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	function makeBashEvent(command: string) {
		return {
			type: "tool_call" as const,
			toolCallId: "test-call-id",
			toolName: "bash",
			input: { command },
		};
	}

	function makeCtx(
		_sandboxDir: string,
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			hasUI: false,
			mode: "tui",
			isProjectTrusted: () => true,
			ui: { notify: (_msg: string, _type?: string) => {} },
			...overrides,
		};
	}

	it("blocks cd ~ via bash handler", async () => {
		process.env.WORKTREE_SANDBOX_PATH = sandboxDir;
		try {
			const event = makeBashEvent("cd ~ && pwd");
			const ctx = makeCtx(sandboxDir);
			const result = await handler(event, ctx);
			assert.ok(result !== undefined, "handler should return a block result");
			assert.equal(result.block, true);
			assert.ok((result.reason ?? "").includes('"~"'));
		} finally {
			delete process.env.WORKTREE_SANDBOX_PATH;
		}
	});

	it("blocks cd $HOME via bash handler", async () => {
		process.env.WORKTREE_SANDBOX_PATH = sandboxDir;
		try {
			const event = makeBashEvent("cd $HOME && touch outside.txt");
			const ctx = makeCtx(sandboxDir);
			const result = await handler(event, ctx);
			assert.ok(result !== undefined, "handler should return a block result");
			assert.equal(result.block, true);
			assert.ok((result.reason ?? "").includes("$HOME"));
		} finally {
			delete process.env.WORKTREE_SANDBOX_PATH;
		}
	});

	it("blocks bare cd via bash handler", async () => {
		process.env.WORKTREE_SANDBOX_PATH = sandboxDir;
		try {
			const event = makeBashEvent("cd && rm -rf important");
			const ctx = makeCtx(sandboxDir);
			const result = await handler(event, ctx);
			assert.ok(result !== undefined, "handler should return a block result");
			assert.equal(result.block, true);
			assert.ok((result.reason ?? "").includes("<HOME>"));
		} finally {
			delete process.env.WORKTREE_SANDBOX_PATH;
		}
	});

	it("allows cd subdir via bash handler (safe, rewrites command)", async () => {
		process.env.WORKTREE_SANDBOX_PATH = sandboxDir;
		try {
			const event = makeBashEvent("cd subdir");
			const ctx = makeCtx(sandboxDir);
			const result = await handler(event, ctx);
			assert.equal(result, undefined);
			assert.equal(event.input.command, `cd "${sandboxDir}" && cd subdir`);
		} finally {
			delete process.env.WORKTREE_SANDBOX_PATH;
		}
	});

	it("blocks cd - via bash handler with descriptive placeholder", async () => {
		process.env.WORKTREE_SANDBOX_PATH = sandboxDir;
		try {
			const event = makeBashEvent("cd - && pwd");
			const ctx = makeCtx(sandboxDir);
			const result = await handler(event, ctx);
			assert.ok(result !== undefined, "handler should return a block result");
			assert.equal(result.block, true);
			assert.ok((result.reason ?? "").includes("<previous-dir>"));
		} finally {
			delete process.env.WORKTREE_SANDBOX_PATH;
		}
	});
});
