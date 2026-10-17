import { describe, it, before, after } from "node:test";

import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

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
		const readResult = mod.rewritePath(
			"read",
			readEvent,
			SANDBOX_ROOT,
			makeCtx(false),
			"file operations",
		);
		assert.ok(readResult !== undefined);
		assert.ok((readResult.reason ?? "").includes("directory"));

		const writeEvent = makeEvent(`${SANDBOX_ROOT}/`);
		const writeResult = mod.rewritePath(
			"write",
			writeEvent,
			SANDBOX_ROOT,
			makeCtx(false),
			"writes",
		);
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
