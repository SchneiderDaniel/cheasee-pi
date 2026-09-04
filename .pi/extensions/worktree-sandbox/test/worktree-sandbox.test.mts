/**
 * Tests: worktree-sandbox/index.ts — rewritePath helper, findUnsafeCd, findUnsafeWriteInBash
 *
 * Phase 1: Pure function unit tests for the extracted rewritePath helper.
 * Tests the path-rewriting logic that was previously duplicated across
 * read/write/edit handlers.
 *
 * Phase 2a: hasShellExpansion — core security helper
 * Phase 2b: findUnsafeCd — all bypass vectors blocked, safe cds pass
 * Phase 3: findUnsafeWriteInBash — redirects, cp, mv, touch
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We export rewritePath from index.ts specifically for testing.
// The default export (extension factory) is also available.
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
	) => import("@earendil-works/pi-coding-agent").ToolCallEventResult | undefined;
	findUnsafeCd: (command: string, sandboxRoot: string) => string | null;
	findUnsafeWriteInBash: (command: string, sandboxRoot: string) => string | null;
	hasShellExpansion: (token: string) => boolean;
};

// https://nodejs.org/api/esm.html#module-register-and-hooks --experimental-strip-types needed
// to import .ts files directly

// ─── Helpers ───────────────────────────────────────────────────────

let SANDBOX_ROOT: string;

function makeEvent(path: string): { input: { path: string } } {
	return { input: { path } };
}

function makeCtx(hasUI: boolean): {
	hasUI: boolean;
	ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
} {
	const notifications: { msg: string; level?: string }[] = [];
	const ctx = {
		hasUI,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ msg: message, level: type });
			},
		},
		// Expose collected notifications for assertion
		_notifications: notifications,
	} as {
		hasUI: boolean;
		ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
		_notifications: { msg: string; level?: string }[];
	};
	return ctx;
}

// ─── Setup: Dynamic import of the module ───────────────────────────

describe("rewritePath", () => {
	before(async () => {
		mod = await import("../index.ts");
	});

	// ── Fixture: real temp directory for directory-guard tests ────
	before(() => {
		SANDBOX_ROOT = mkdtempSync(join(tmpdir(), "sandbox-dir-test-"));
		mkdirSync(join(SANDBOX_ROOT, "subdir"));
	});

	after(() => {
		if (SANDBOX_ROOT) {
			rmSync(SANDBOX_ROOT, { recursive: true, force: true });
		}
	});

	// ── Empty path ────────────────────────────────────────────────

	it("returns undefined for empty path (pass-through)", () => {
		const event = makeEvent("");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
	});

	it("returns undefined for falsy path (pass-through)", () => {
		// Can't test null/undefined since event.input.path is typed as string
		// but empty string is handled
		const event = makeEvent("");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
	});

	// ── Absolute path inside sandbox ───────────────────────────────

	it("returns `{ block: true, reason }` for absolute path equal to sandbox root when tool is `read`", () => {
		const event = makeEvent(SANDBOX_ROOT);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("directory"));
		assert.ok((result.reason ?? "").includes("bash ls"));
	});

	it("returns undefined for absolute path inside sandbox (subdirectory)", () => {
		const event = makeEvent(join(SANDBOX_ROOT, "some/file.txt"));
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
	});

	// ── Absolute path outside sandbox ─────────────────────────────

	it("blocks absolute path outside sandbox with correct block noun (file operations)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("outside the worktree"));
	});

	it("blocks absolute path outside sandbox with correct block noun (writes)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("write", event, SANDBOX_ROOT, ctx, "writes");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("outside the worktree"));
	});

	it("blocks absolute path outside sandbox with correct block noun (edits)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("edit", event, SANDBOX_ROOT, ctx, "edits");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("outside the worktree"));
	});

	// ── Relative path resolving inside sandbox ─────────────────────

	it("mutates event.input.path and returns undefined for relative path that resolves inside sandbox", () => {
		const event = makeEvent("relative/file.txt");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
		assert.equal(event.input.path, join(SANDBOX_ROOT, "relative/file.txt"));
	});

	// ── Relative path resolving outside sandbox ───────────────────

	it("blocks relative path that resolves outside sandbox with 'resolves outside' message", () => {
		const event = makeEvent("../../outside");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("resolves outside"));
	});

	// ── UI notification ───────────────────────────────────────────

	it("calls ctx.ui.notify() with correct tool name when ctx.hasUI is true (read)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		const spy = ctx.ui.notify as ReturnType<typeof makeCtx>["ui"]["notify"] & { calls?: unknown[] };
		const originalNotify = ctx.ui.notify;
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.equal(calls.length, 1);
		assert.ok(
			calls[0].msg.includes("read"),
			`Expected notify call to mention "read" but got: ${calls[0].msg}`,
		);
		ctx.ui.notify = originalNotify;
	});

	it("calls ctx.ui.notify() with correct tool name when ctx.hasUI is true (write)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};
		const result = mod.rewritePath("write", event, SANDBOX_ROOT, ctx, "writes");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.equal(calls.length, 1);
		assert.ok(
			calls[0].msg.includes("write"),
			`Expected notify call to mention "write" but got: ${calls[0].msg}`,
		);
	});

	it("calls ctx.ui.notify() with correct tool name when ctx.hasUI is true (edit)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};
		const result = mod.rewritePath("edit", event, SANDBOX_ROOT, ctx, "edits");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.equal(calls.length, 1);
		assert.ok(
			calls[0].msg.includes("edit"),
			`Expected notify call to mention "edit" but got: ${calls[0].msg}`,
		);
	});

	it("does not call ctx.ui.notify() when ctx.hasUI is false", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(false);
		const spy = ctx.ui.notify as ReturnType<typeof makeCtx>["ui"]["notify"] & { calls?: unknown[] };
		const originalNotify = ctx.ui.notify;
		let called = false;
		ctx.ui.notify = () => {
			called = true;
		};
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.equal(called, false);
		ctx.ui.notify = originalNotify;
	});

	it("notifies with error level when ctx.hasUI is true and mode is not tui", () => {
		// When mode is "cli", notification should be "error"-level (more visible)
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		(ctx as Record<string, unknown>).mode = "cli";
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].level, "error");
	});

	it("notifies with warning level when ctx.hasUI is true and mode is tui", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		(ctx as Record<string, unknown>).mode = "tui";
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].level, "warning");
	});

	it("notifies with warning level when ctx.hasUI is true and mode is undefined (fallback)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		// mode undefined by default in makeCtx
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].level, "warning");
	});

	// ── Path traversal via `..` within sandbox ────────────────────

	it("resolves path traversal within sandbox", () => {
		const event = makeEvent("dir/../file.txt");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
		assert.equal(event.input.path, join(SANDBOX_ROOT, "file.txt"));
	});

	it("blocks path traversal that escapes sandbox", () => {
		const event = makeEvent("../../outside");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("resolves outside"));
	});

	// ── Absolute directory inside sandbox (read tool) ────────────

	it("returns `{ block: true, reason }` for `read` on absolute directory inside sandbox (subdirectory)", () => {
		const event = makeEvent(join(SANDBOX_ROOT, "subdir"));
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("directory"));
		assert.ok((result.reason ?? "").includes("bash ls"));
	});

	it("returns undefined for `read` on file inside sandbox (not a directory)", () => {
		// This test writes an actual file so statSync resolves to a non-directory
		const filePath = join(SANDBOX_ROOT, "test-file.txt");
		writeFileSync(filePath, "hello", "utf-8");
		try {
			const event = makeEvent(filePath);
			const ctx = makeCtx(false);
			const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
			assert.equal(result, undefined);
		} finally {
			rmSync(filePath);
		}
	});

	it("returns undefined for `write` on directory path (only `read` is blocked)", () => {
		const event = makeEvent(SANDBOX_ROOT);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("write", event, SANDBOX_ROOT, ctx, "writes");
		assert.equal(result, undefined);
	});

	it("returns undefined for `edit` on directory path (only `read` is blocked)", () => {
		const event = makeEvent(SANDBOX_ROOT);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("edit", event, SANDBOX_ROOT, ctx, "edits");
		assert.equal(result, undefined);
	});

	it("blocks `read` on absolute directory that is outside sandbox (still shows 'outside' error not 'directory')", () => {
		// Outside directories should still be blocked by the outside-sandbox guard first
		const event = makeEvent("/tmp");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		// The first guard catches it — the 'outside worktree' message takes priority
		assert.ok((result.reason ?? "").includes("outside the worktree"));
	});

	it("returns undefined for non-existent path (ENOENT — pass through to pi-core)", () => {
		const event = makeEvent(join(SANDBOX_ROOT, "nonexistent-file.txt"));
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
	});

	// ── Absolute path with `..` components (traversal, CWE-22) ────

	it("blocks absolute path with .. that escapes sandbox (file operations)", () => {
		const event = makeEvent(`${SANDBOX_ROOT}/../../../../etc/passwd`);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("outside the worktree"));
	});

	it("blocks absolute path with .. that escapes sandbox (writes)", () => {
		const event = makeEvent(`${SANDBOX_ROOT}/../../../../etc/passwd`);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("write", event, SANDBOX_ROOT, ctx, "writes");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("outside the worktree"));
	});

	it("blocks absolute path with .. that escapes sandbox (edits)", () => {
		const event = makeEvent(`${SANDBOX_ROOT}/../../../../etc/passwd`);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("edit", event, SANDBOX_ROOT, ctx, "edits");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("outside the worktree"));
	});

	it("blocks absolute path with .. resolving above the root", () => {
		const event = makeEvent(`${SANDBOX_ROOT}/sub/../../../..`);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("outside the worktree"));
	});

	it("blocks absolute path with double-slash and .. (Vite CVE class)", () => {
		const event = makeEvent(`${SANDBOX_ROOT}//../..`);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("outside the worktree"));
	});

	it("passes through absolute path with in-sandbox .. and normalizes event.input.path", () => {
		const event = makeEvent(`${SANDBOX_ROOT}/sub/../file.txt`);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
		assert.equal(event.input.path, join(SANDBOX_ROOT, "file.txt"));
	});

	it("passes through already-normal absolute in-sandbox path (idempotent no-op)", () => {
		const event = makeEvent(join(SANDBOX_ROOT, "some/file.txt"));
		const ctx = makeCtx(false);
		const result = mod.rewritePath("write", event, SANDBOX_ROOT, ctx, "writes");
		assert.equal(result, undefined);
		assert.equal(event.input.path, join(SANDBOX_ROOT, "some/file.txt"));
	});

	it("blocks read on absolute in-sandbox directory even with .. in the raw path (reason names original)", () => {
		const event = makeEvent(`${SANDBOX_ROOT}/sub/../subdir`);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("directory"));
		assert.ok((result.reason ?? "").includes("bash ls"));
	});

	it("read on outside directory via .. reports 'outside the worktree' not 'directory'", () => {
		const event = makeEvent(`${SANDBOX_ROOT}/../../../../tmp`);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("outside the worktree"));
	});

	it("trailing slash on root is contained; read blocked as directory, write/edit normalize to root", () => {
		const readEvent = makeEvent(`${SANDBOX_ROOT}/`);
		const readResult = mod.rewritePath("read", readEvent, SANDBOX_ROOT, makeCtx(false), "file operations");
		assert.ok(readResult !== undefined);
		assert.ok((readResult.reason ?? "").includes("directory"));

		const writeEvent = makeEvent(`${SANDBOX_ROOT}/`);
		const writeResult = mod.rewritePath("write", writeEvent, SANDBOX_ROOT, makeCtx(false), "writes");
		assert.equal(writeResult, undefined);
		assert.equal(writeEvent.input.path, SANDBOX_ROOT);
	});

	it("blocks prefix-sibling path <root>-evil/file", () => {
		const event = makeEvent(`${SANDBOX_ROOT}-evil/file`);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("outside the worktree"));
	});

	it("Windows-form path C:\\x is treated as relative on POSIX (contained inside sandbox)", () => {
		const event = makeEvent("C:\\x");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("write", event, SANDBOX_ROOT, ctx, "writes");
		assert.equal(result, undefined);
	});
});

// ─── Phase 2a: hasShellExpansion ───────────────────────────────────

describe("hasShellExpansion", () => {
	before(async () => {
		mod = await import("../index.ts");
	});

	it("returns true for variable expansion $VAR", () => {
		assert.equal(mod.hasShellExpansion("$HOME"), true);
	});

	it("returns true for variable expansion ${VAR}", () => {
		assert.equal(mod.hasShellExpansion("${HOME}"), true);
	});

	it("returns true for command substitution $()", () => {
		assert.equal(mod.hasShellExpansion("$(id)"), true);
	});

	it("returns true for backtick command substitution", () => {
		assert.equal(mod.hasShellExpansion("`id`"), true);
	});

	it("returns true for wildcard glob *", () => {
		assert.equal(mod.hasShellExpansion("*.txt"), true);
	});

	it("returns true for wildcard glob ?", () => {
		assert.equal(mod.hasShellExpansion("file?.txt"), true);
	});

	it("returns true for wildcard glob [...]", () => {
		assert.equal(mod.hasShellExpansion("file[0-9].txt"), true);
	});

	it("returns true for single quotes", () => {
		assert.equal(mod.hasShellExpansion("'test'"), true);
	});

	it("returns true for double quotes", () => {
		assert.equal(mod.hasShellExpansion('"test"'), true);
	});

	it("returns true for semicolon command chaining", () => {
		assert.equal(mod.hasShellExpansion("dir;ls"), true);
	});

	it("returns true for pipe", () => {
		assert.equal(mod.hasShellExpansion("dir|ls"), true);
	});

	it("returns true for OR operator ||", () => {
		assert.equal(mod.hasShellExpansion("false||true"), true);
	});

	it("returns true for AND operator &&", () => {
		assert.equal(mod.hasShellExpansion("true&&false"), true);
	});

	it("returns true for background operator &", () => {
		assert.equal(mod.hasShellExpansion("sleep 10&"), true);
	});

	it("returns false for plain path without shell metacharacters", () => {
		assert.equal(mod.hasShellExpansion("/home/user/file.txt"), false);
	});

	it("returns false for hyphen flags", () => {
		assert.equal(mod.hasShellExpansion("--help"), false);
	});

	it("returns false for numeric", () => {
		assert.equal(mod.hasShellExpansion("42"), false);
	});
});

// ─── Phase 3: findUnsafeWriteInBash ────────────────────────────────

describe("findUnsafeWriteInBash", () => {
	before(async () => {
		mod = await import("../index.ts");
	});

	const SANDBOX = "/home/user/project";

	it("returns null for a simple cd (no write)", () => {
		assert.equal(mod.findUnsafeWriteInBash(`cd ${SANDBOX}`, SANDBOX), null);
	});

	it("returns null for a no-op redirect that stays inside", () => {
		assert.equal(mod.findUnsafeWriteInBash(`echo hello > ${SANDBOX}/file.txt`, SANDBOX), null);
	});

	it("returns reason for redirect to outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("echo data > /etc/outside.txt", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns reason for append redirect to outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("echo more >> /etc/passwd", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns reason for heredoc write to outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("cat << EOF > /etc/outside.txt", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for heredoc write inside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash(`cat << EOF > ${SANDBOX}/data.txt`, SANDBOX), null);
	});

	it("returns reason for cp destination outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash(`cp ${SANDBOX}/a.txt /etc/out`, SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for cp inside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash(`cp ${SANDBOX}/a.txt ${SANDBOX}/b.txt`, SANDBOX), null);
	});

	it("returns reason for mv destination outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash(`mv ${SANDBOX}/a.txt /tmp/out`, SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for mv inside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash(`mv ${SANDBOX}/a.txt ${SANDBOX}/b.txt`, SANDBOX), null);
	});

	it("returns reason for touch outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("touch /etc/outside.txt", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for touch inside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash(`touch ${SANDBOX}/newfile.txt`, SANDBOX), null);
	});

	it("returns null for tee inside sandbox", () => {
		assert.equal(mod.findUnsafeWriteInBash(`echo data | tee ${SANDBOX}/log.txt`, SANDBOX), null);
	});

	it("returns reason for tee outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("echo data | tee /etc/outside.txt", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns reason for dd of outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash(
			"dd if=/dev/zero of=/etc/outside.txt bs=1 count=1",
			SANDBOX,
		);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for dd inside sandbox", () => {
		assert.equal(
			mod.findUnsafeWriteInBash(`dd if=/dev/zero of=${SANDBOX}/test.bin bs=1 count=1`, SANDBOX),
			null,
		);
	});

	it("returns reason for install outside sandbox", () => {
		const result = mod.findUnsafeWriteInBash("install -m 755 file /usr/local/bin/prog", SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for install inside sandbox", () => {
		assert.equal(
			mod.findUnsafeWriteInBash(`install -m 755 ${SANDBOX}/file ${SANDBOX}/bin/prog`, SANDBOX),
			null,
		);
	});

	it("returns reason for ln -s target outside sandbox (symlink escape)", () => {
		const result = mod.findUnsafeWriteInBash(`ln -s /etc/passwd ${SANDBOX}/link`, SANDBOX);
		assert.ok(result !== null);
		assert.ok(result.includes("outside"));
	});

	it("returns null for ln -s inside sandbox", () => {
		assert.equal(
			mod.findUnsafeWriteInBash(`ln -s ${SANDBOX}/a.txt ${SANDBOX}/link`, SANDBOX),
			null,
		);
	});

	it("returns null for ln without -s (hard link)", () => {
		assert.equal(mod.findUnsafeWriteInBash(`ln ${SANDBOX}/a.txt ${SANDBOX}/b.txt`, SANDBOX), null);
	});
});
