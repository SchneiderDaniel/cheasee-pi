/**
 * Tests for checks/shared.ts — shared utilities for supervisor checks
 *
 * Covers all exports: getChangedFilesFromGitDiff, isExecutableNotFound.
 * filterItemsToChangedFiles and sumLines were removed (inlined at consumer sites).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/checks/shared.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getChangedFilesFromGitDiff, isExecutableNotFound } from "../../checks/shared.ts";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

type ExecFn = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

function makeExec(results: Array<{ code: number; stdout: string; stderr: string }>): ExecFn {
	let idx = 0;
	return async (_cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
		const r = results[idx] || { code: 0, stdout: "", stderr: "" };
		idx++;
		return Promise.resolve(r);
	};
}

function makeRejectingExec(error: unknown): ExecFn {
	return async (_cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
		throw error;
	};
}

// ═══════════════════════════════════════════════════════════════════════
// getChangedFilesFromGitDiff
// ═══════════════════════════════════════════════════════════════════════

describe("getChangedFilesFromGitDiff()", () => {
	it("happy path returns trimmed file list", async () => {
		const exec = makeExec([{ code: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" }]);
		const files = await getChangedFilesFromGitDiff(exec, "/tmp/worktree", "main");
		assert.deepEqual(files, ["src/a.ts", "src/b.ts"]);
	});

	it("empty stdout returns empty array", async () => {
		const exec = makeExec([{ code: 0, stdout: "", stderr: "" }]);
		const files = await getChangedFilesFromGitDiff(exec, "/tmp/worktree", "main");
		assert.deepEqual(files, []);
	});

	it("single file returns that file", async () => {
		const exec = makeExec([{ code: 0, stdout: "src/a.ts\n", stderr: "" }]);
		const files = await getChangedFilesFromGitDiff(exec, "/tmp/worktree", "main");
		assert.deepEqual(files, ["src/a.ts"]);
	});

	it("whitespace lines are filtered out", async () => {
		const exec = makeExec([{ code: 0, stdout: "src/a.ts\n\n  \nsrc/b.ts\n", stderr: "" }]);
		const files = await getChangedFilesFromGitDiff(exec, "/tmp/worktree", "main");
		assert.deepEqual(files, ["src/a.ts", "src/b.ts"]);
	});

	it("non-zero exit throws Error with stderr", async () => {
		const exec = makeExec([{ code: 128, stdout: "", stderr: "fatal: not a git repository" }]);
		await assert.rejects(() => getChangedFilesFromGitDiff(exec, "/tmp/worktree", "main"), {
			message: "git diff failed: fatal: not a git repository",
		});
	});

	it("non-zero exit with empty stderr reports unknown error", async () => {
		const exec = makeExec([{ code: 1, stdout: "", stderr: "" }]);
		await assert.rejects(() => getChangedFilesFromGitDiff(exec, "/tmp/worktree", "main"), {
			message: "git diff failed: unknown error",
		});
	});

	it("exec throws ENOENT — propagates (caller uses isExecutableNotFound)", async () => {
		const enoent = new Error("spawn git ENOENT");
		(enoent as NodeJS.ErrnoException).code = "ENOENT";
		const exec = makeRejectingExec(enoent);
		try {
			await getChangedFilesFromGitDiff(exec, "/tmp/worktree", "main");
			assert.fail("should have thrown");
		} catch (err: unknown) {
			assert.ok(isExecutableNotFound(err));
		}
	});

	it("exec throws generic Error — propagates", async () => {
		const exec = makeRejectingExec(new Error("connection timeout"));
		await assert.rejects(() => getChangedFilesFromGitDiff(exec, "/tmp/worktree", "main"), {
			message: "connection timeout",
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// isExecutableNotFound
// ═══════════════════════════════════════════════════════════════════════

describe("isExecutableNotFound()", () => {
	it("Error with code === 'ENOENT' returns true", () => {
		const err = new Error("spawn ENOENT");
		(err as NodeJS.ErrnoException).code = "ENOENT";
		assert.equal(isExecutableNotFound(err), true);
	});

	it("Error without code returns false", () => {
		const err = new Error("generic error");
		assert.equal(isExecutableNotFound(err), false);
	});

	it("Error with code === 'EACCES' returns false", () => {
		const err = new Error("permission denied");
		(err as NodeJS.ErrnoException).code = "EACCES";
		assert.equal(isExecutableNotFound(err), false);
	});

	it("string input returns false", () => {
		assert.equal(isExecutableNotFound("ENOENT"), false);
	});

	it("null input returns false", () => {
		assert.equal(isExecutableNotFound(null), false);
	});
});
