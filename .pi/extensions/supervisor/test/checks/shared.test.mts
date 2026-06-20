/**
 * Tests for checks/shared.ts — shared utilities for supervisor checks
 *
 * Covers all exports: getChangedFilesFromGitDiff, filterItemsToChangedFiles,
 * sumLines, isExecutableNotFound, and compile-time ExecFn type check.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/checks/shared.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	getChangedFilesFromGitDiff,
	filterItemsToChangedFiles,
	sumLines,
	isExecutableNotFound,
} from "../../checks/shared.ts";

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
// filterItemsToChangedFiles
// ═══════════════════════════════════════════════════════════════════════

interface TestItem {
	id: string;
	file: string;
}

describe("filterItemsToChangedFiles()", () => {
	const items: TestItem[] = [
		{ id: "a", file: "src/a.ts" },
		{ id: "b", file: "src/b.ts" },
		{ id: "c", file: "src/c.ts" },
	];

	it("keeps items whose getFiles includes a changed file", () => {
		const result = filterItemsToChangedFiles(items, ["src/a.ts"], (item) => [item.file]);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.id, "a");
	});

	it("drops items with no intersection", () => {
		const result = filterItemsToChangedFiles(items, ["src/z.ts"], (item) => [item.file]);
		assert.equal(result.length, 0);
	});

	it("returns correct subset for mixed set", () => {
		const result = filterItemsToChangedFiles(items, ["src/a.ts", "src/c.ts"], (item) => [
			item.file,
		]);
		assert.equal(result.length, 2);
		assert.deepEqual(result.map((r) => r.id).sort(), ["a", "c"]);
	});

	it("empty items returns empty array", () => {
		const result = filterItemsToChangedFiles([] as TestItem[], ["src/a.ts"], (item) => [item.file]);
		assert.deepEqual(result, []);
	});

	it("empty changedFiles returns empty array", () => {
		const result = filterItemsToChangedFiles(items, [], (item) => [item.file]);
		assert.deepEqual(result, []);
	});

	it("item with multiple files kept if any matches", () => {
		const multiFiles = [
			{ id: "x", files: ["src/other.ts", "src/target.ts"] },
			{ id: "y", files: ["src/other.ts", "src/unrelated.ts"] },
		];
		const result = filterItemsToChangedFiles(multiFiles, ["src/target.ts"], (item) => item.files);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.id, "x");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// sumLines
// ═══════════════════════════════════════════════════════════════════════

describe("sumLines()", () => {
	it("three items with extractors [1,2,3] returns 6", () => {
		const result = sumLines([1, 2, 3], (n) => n);
		assert.equal(result, 6);
	});

	it("empty array returns 0", () => {
		const result = sumLines([], () => 1);
		assert.equal(result, 0);
	});

	it("items with zero from extractor counted as 0", () => {
		const result = sumLines([{ v: 0 }, { v: 5 }, { v: 0 }], (item) => item.v);
		assert.equal(result, 5);
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
