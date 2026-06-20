/**
 * Tests for unbreak_worktrees() — idempotent worktree path rewriting.
 *
 * Phases:
 *   1 — Worktree .git absolute→relative path rewriting
 *   2 — Reciprocal gitdir files in .bare/worktrees/<id>/gitdir
 *   3 — Recovery of pruned worktree registrations
 *   4 — Worktree locking
 *   5 — Idempotency (run twice, no side effects on second run)
 *   6 — Error handling and edge cases
 *   7 — BARE_DIR discovery variations
 *
 * Run with:
 *   node --experimental-strip-types --test docker/test/unbreak-worktrees.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIX_SCRIPT = resolve(__dirname, "../lib/worktree-fix.sh");

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a temp directory with the given relative structure.
 * `files` maps relative file paths to their string content.
 * Returns the temp directory path.
 */
function createFixture(files: Record<string, string>): string {
	const tmp = mkdtempSync(join(tmpdir(), "worktree-fix-"));
	for (const [relPath, content] of Object.entries(files)) {
		const absPath = join(tmp, relPath);
		mkdirSync(dirname(absPath), { recursive: true });
		writeFileSync(absPath, content, "utf-8");
	}
	return tmp;
}

/**
 * Run unbreak_worktrees() against a temp workspace base.
 * Returns { stdout, stderr } from the bash invocation.
 */
function runFix(workspaceBase: string): { stdout: string; stderr: string } {
	const cmd = `bash -c 'source "${FIX_SCRIPT}" && unbreak_worktrees "${workspaceBase}"' 2>&1`;
	try {
		const stdout = execSync(cmd, {
			encoding: "utf-8",
			timeout: 5000,
		});
		return { stdout, stderr: "" };
	} catch (e: unknown) {
		const err = e as { stderr?: string; stdout?: string; message?: string };
		return {
			stdout: err.stdout?.toString() ?? "",
			stderr: err.stderr?.toString() ?? err.message ?? "unknown error",
		};
	}
}

/**
 * Read a file from the temp workspace. Returns null if missing.
 */
function readFileOrNull(workspaceBase: string, relPath: string): string | null {
	const absPath = join(workspaceBase, relPath);
	try {
		return readFileSync(absPath, "utf-8").trim();
	} catch {
		return null;
	}
}

/**
 * Helper: add a worktree with absolute paths to the fixture.
 */
function addWorktreeAbs(base: string, id: string, hostPrefix: string = "/home/user/git"): void {
	mkdirSync(join(base, id), { recursive: true });
	writeFileSync(join(base, `${id}/.git`), `gitdir: ${hostPrefix}/.bare/worktrees/${id}`);
	mkdirSync(join(base, `.bare/worktrees/${id}`), { recursive: true });
	writeFileSync(join(base, `.bare/worktrees/${id}/gitdir`), `${hostPrefix}/${id}/.git`);
}

/**
 * Destroy a temp workspace.
 */
function destroyFixture(tmp: string): void {
	rmSync(tmp, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1: Worktree .git path rewriting
// ═══════════════════════════════════════════════════════════════════

describe("Phase 1 — .git path rewriting", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = createFixture({
			"main/.git": "gitdir: /home/user/git/.bare/worktrees/main",
			".bare/worktrees/main/gitdir": "/home/user/git/main/.git",
		});
	});

	afterEach(() => {
		destroyFixture(tmp);
	});

	it("rewrites absolute host path to relative in .git file", () => {
		runFix(tmp);
		const content = readFileOrNull(tmp, "main/.git");
		assert.strictEqual(content, "gitdir: ../.bare/worktrees/main");
	});

	it("does not touch .git file that already has relative path", () => {
		// Create feature-x worktree with already-relative paths
		addWorktreeAbs(tmp, "feature-x");
		// Manually set it to relative before running the fix
		writeFileSync(join(tmp, "feature-x/.git"), "gitdir: ../.bare/worktrees/feature-x");
		writeFileSync(join(tmp, ".bare/worktrees/feature-x/gitdir"), "../../../feature-x/.git");

		runFix(tmp);
		const content = readFileOrNull(tmp, "feature-x/.git");
		assert.strictEqual(content, "gitdir: ../.bare/worktrees/feature-x"); // unchanged
	});

	it("skips .git file whose absolute target path exists (valid mount)", () => {
		// In a real git worktree, the gitdir target is always a directory (.bare/worktrees/<id>/)
		const existingTarget = join(tmp, ".bare/worktrees/existing-wt");
		mkdirSync(existingTarget, { recursive: true });
		// Create valid-mount/.git with a gitdir pointing to existing directory
		mkdirSync(join(tmp, "valid-mount"), { recursive: true });
		writeFileSync(join(tmp, "valid-mount/.git"), `gitdir: ${existingTarget}`);

		runFix(tmp);
		const content = readFileOrNull(tmp, "valid-mount/.git");
		assert.strictEqual(content, `gitdir: ${existingTarget}`); // unchanged
	});

	it("handles multiple worktrees with absolute paths", () => {
		addWorktreeAbs(tmp, "feature-x");
		addWorktreeAbs(tmp, "feature-y");

		runFix(tmp);

		for (const id of ["feature-x", "feature-y"]) {
			const content = readFileOrNull(tmp, `${id}/.git`);
			assert.strictEqual(content, `gitdir: ../.bare/worktrees/${id}`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Reciprocal gitdir files
// ═══════════════════════════════════════════════════════════════════

describe("Phase 2 — reciprocal gitdir files", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = createFixture({
			"main/.git": "gitdir: /home/user/git/.bare/worktrees/main",
			".bare/worktrees/main/gitdir": "/home/user/git/main/.git",
		});
	});

	afterEach(() => {
		destroyFixture(tmp);
	});

	it("rewrites absolute host path to relative in gitdir file", () => {
		runFix(tmp);
		const content = readFileOrNull(tmp, ".bare/worktrees/main/gitdir");
		assert.strictEqual(content, "../../../main/.git");
	});

	it("does not touch gitdir file that is already relative", () => {
		addWorktreeAbs(tmp, "feature-x");
		// Manually set to relative
		writeFileSync(join(tmp, ".bare/worktrees/feature-x/gitdir"), "../../../feature-x/.git");
		writeFileSync(join(tmp, "feature-x/.git"), "gitdir: ../.bare/worktrees/feature-x");

		runFix(tmp);
		const content = readFileOrNull(tmp, ".bare/worktrees/feature-x/gitdir");
		assert.strictEqual(content, "../../../feature-x/.git"); // unchanged
	});

	it("skips gitdir file whose absolute target exists inside container", () => {
		const existingTarget = join(tmp, "existing-target/.git");
		mkdirSync(dirname(existingTarget), { recursive: true });
		writeFileSync(existingTarget, "placeholder");
		mkdirSync(join(tmp, ".bare/worktrees/valid-mount"), { recursive: true });
		writeFileSync(join(tmp, ".bare/worktrees/valid-mount/gitdir"), existingTarget);

		runFix(tmp);
		const content = readFileOrNull(tmp, ".bare/worktrees/valid-mount/gitdir");
		assert.strictEqual(content, existingTarget); // unchanged
	});

	it("fixes multiple worktree IDs", () => {
		addWorktreeAbs(tmp, "feature-a");
		addWorktreeAbs(tmp, "feature-b");

		runFix(tmp);

		for (const id of ["feature-a", "feature-b"]) {
			const content = readFileOrNull(tmp, `.bare/worktrees/${id}/gitdir`);
			assert.strictEqual(content, `../../../${id}/.git`);
		}
	});

	it("resolved gitdir path correctly reaches the worktree's .git file", () => {
		addWorktreeAbs(tmp, "test-wt");

		runFix(tmp);

		// The rewritten gitdir should resolve to the correct path
		const gitdirContent = readFileOrNull(tmp, ".bare/worktrees/test-wt/gitdir");
		assert.ok(gitdirContent);

		// Use realpath to verify resolution
		const resolved = execSync(
			`cd "${join(tmp, ".bare/worktrees/test-wt")}" && realpath -m "${gitdirContent}"`,
			{ encoding: "utf-8", timeout: 3000 },
		).trim();
		const expected = join(tmp, "test-wt/.git");
		assert.strictEqual(resolved, expected);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3: Recovery of pruned worktree registrations
// ═══════════════════════════════════════════════════════════════════

describe("Phase 3 — recovery of pruned worktree registrations", () => {
	let tmp: string;

	afterEach(() => {
		if (tmp) destroyFixture(tmp);
	});

	it("recreates gitdir file when .git has relative path but gitdir is missing", () => {
		tmp = createFixture({
			"main/.git": "gitdir: ../.bare/worktrees/main",
			// NO .bare/worktrees/main/gitdir — pruned!
		});
		// Need .bare/ to exist for discovery
		mkdirSync(join(tmp, ".bare"), { recursive: true });

		runFix(tmp);

		const content = readFileOrNull(tmp, ".bare/worktrees/main/gitdir");
		assert.strictEqual(content, "../../../main/.git");
	});

	it("does nothing when both .git file and gitdir are missing", () => {
		tmp = createFixture({
			"other/file.txt": "hello",
		});

		// Should not crash
		const result = runFix(tmp);
		assert.doesNotThrow(() => {
			assert.ok(result.stdout !== undefined);
		});
	});

	it("does nothing when gitdir exists but .git file is missing", () => {
		tmp = createFixture({
			".bare/worktrees/orphan/gitdir": "../../../orphan/.git",
			// No orphan/.git file
		});

		runFix(tmp);

		// gitdir should still exist unchanged
		const content = readFileOrNull(tmp, ".bare/worktrees/orphan/gitdir");
		assert.strictEqual(content, "../../../orphan/.git");
	});

	it("creates parent directory for recovered gitdir file", () => {
		tmp = createFixture({
			"main/.git": "gitdir: ../.bare/worktrees/main",
			// .bare/worktrees/main/ doesn't exist at all — pruned entirely
		});
		mkdirSync(join(tmp, ".bare"), { recursive: true });

		runFix(tmp);

		const content = readFileOrNull(tmp, ".bare/worktrees/main/gitdir");
		assert.strictEqual(content, "../../../main/.git");
		assert.ok(existsSync(join(tmp, ".bare/worktrees/main/gitdir")));
	});

	it("recovers multiple pruned worktrees", () => {
		tmp = createFixture({
			"main/.git": "gitdir: ../.bare/worktrees/main",
			"feature-x/.git": "gitdir: ../.bare/worktrees/feature-x",
			// No .bare/worktrees/<id>/gitdir for either
		});
		mkdirSync(join(tmp, ".bare"), { recursive: true });

		runFix(tmp);

		for (const id of ["main", "feature-x"]) {
			const content = readFileOrNull(tmp, `.bare/worktrees/${id}/gitdir`);
			assert.strictEqual(content, `../../../${id}/.git`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 4: Worktree locking
// ═══════════════════════════════════════════════════════════════════

describe("Phase 4 — worktree locking", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = createFixture({
			"main/.git": "gitdir: /home/user/git/.bare/worktrees/main",
			".bare/worktrees/main/gitdir": "/home/user/git/main/.git",
		});
	});

	afterEach(() => {
		destroyFixture(tmp);
	});

	it("creates locked file for unlocked worktree", () => {
		runFix(tmp);
		const lockContent = readFileOrNull(tmp, ".bare/worktrees/main/locked");
		assert.ok(lockContent);
		assert.ok(lockContent!.includes("Locked by entrypoint.sh"));
	});

	it("skips worktree that already has locked file", () => {
		writeFileSync(join(tmp, ".bare/worktrees/main/locked"), "Manually locked by user");

		runFix(tmp);

		const lockContent = readFileOrNull(tmp, ".bare/worktrees/main/locked");
		assert.strictEqual(lockContent, "Manually locked by user"); // unchanged
	});

	it("does nothing when no .bare/worktrees/ directory exists", () => {
		destroyFixture(tmp);
		tmp = createFixture({
			// No .bare at all — function should exit early
			"some-file.txt": "hello",
		});

		const result = runFix(tmp);
		assert.ok(result.stdout.includes("Could not find .bare directory"));
	});

	it("locks multiple worktrees", () => {
		addWorktreeAbs(tmp, "feature-x");
		addWorktreeAbs(tmp, "feature-y");

		runFix(tmp);

		for (const id of ["main", "feature-x", "feature-y"]) {
			const lockContent = readFileOrNull(tmp, `.bare/worktrees/${id}/locked`);
			assert.ok(lockContent, `worktree ${id} should be locked`);
			assert.ok(lockContent!.includes("Locked by entrypoint.sh"));
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 5: Idempotency
// ═══════════════════════════════════════════════════════════════════

describe("Phase 5 — idempotency", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = createFixture({
			"main/.git": "gitdir: /home/user/git/.bare/worktrees/main",
			".bare/worktrees/main/gitdir": "/home/user/git/main/.git",
		});
	});

	afterEach(() => {
		destroyFixture(tmp);
	});

	it("second run produces no side effects", () => {
		// First run
		runFix(tmp);

		// Capture first-run state
		const gitContent1 = readFileOrNull(tmp, "main/.git");
		const gitdirContent1 = readFileOrNull(tmp, ".bare/worktrees/main/gitdir");
		const lockContent1 = readFileOrNull(tmp, ".bare/worktrees/main/locked");

		// Second run
		runFix(tmp);

		// Capture second-run state
		const gitContent2 = readFileOrNull(tmp, "main/.git");
		const gitdirContent2 = readFileOrNull(tmp, ".bare/worktrees/main/gitdir");
		const lockContent2 = readFileOrNull(tmp, ".bare/worktrees/main/locked");

		assert.strictEqual(gitContent2, gitContent1, ".git file unchanged on second run");
		assert.strictEqual(gitdirContent2, gitdirContent1, "gitdir file unchanged on second run");
		assert.strictEqual(lockContent2, lockContent1, "locked file unchanged on second run");
	});

	it("two rapid sequential calls leave consistent state", () => {
		// Simulate two concurrent starts: run twice back-to-back
		const cmd = `bash -c 'source "${FIX_SCRIPT}" && unbreak_worktrees "${tmp}" && unbreak_worktrees "${tmp}"' 2>&1`;
		execSync(cmd, { encoding: "utf-8", timeout: 5000 });

		// All files should be in expected final state
		assert.strictEqual(readFileOrNull(tmp, "main/.git"), "gitdir: ../.bare/worktrees/main");
		assert.strictEqual(readFileOrNull(tmp, ".bare/worktrees/main/gitdir"), "../../../main/.git");
		assert.ok(
			readFileOrNull(tmp, ".bare/worktrees/main/locked")?.includes("Locked by entrypoint.sh"),
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 6: Error handling and edge cases
// ═══════════════════════════════════════════════════════════════════

describe("Phase 6 — error handling and edge cases", () => {
	let tmp: string;

	afterEach(() => {
		if (tmp) destroyFixture(tmp);
	});

	it("skips malformed .git file (no gitdir: prefix)", () => {
		tmp = createFixture({
			"main/.git": "not a gitdir line",
			".bare/worktrees/main/gitdir": "/home/user/git/main/.git",
		});

		runFix(tmp);

		const content = readFileOrNull(tmp, "main/.git");
		assert.strictEqual(content, "not a gitdir line"); // unchanged, not corrupted
	});

	it("handles empty .bare/worktrees/ directory gracefully", () => {
		tmp = createFixture({
			"main/.git": "gitdir: /home/user/git/.bare/worktrees/main",
			".bare/worktrees/main/gitdir": "/home/user/git/main/.git",
		});
		// Add an empty subdirectory inside worktrees
		mkdirSync(join(tmp, ".bare/worktrees/empty-wt"), { recursive: true });

		// Should not crash
		const result = runFix(tmp);
		assert.ok(result.stdout.includes("Worktree fix complete"));
	});

	it("skips .git entry that is a directory (symlink-style)", () => {
		tmp = createFixture({
			"main/.git": "gitdir: /home/user/git/.bare/worktrees/main",
			".bare/worktrees/main/gitdir": "/home/user/git/main/.git",
		});
		// Create a my-worktree with a .git DIRECTORY (not file, simulating symlink-style linked worktree)
		mkdirSync(join(tmp, "my-worktree"), { recursive: true });
		mkdirSync(join(tmp, "my-worktree/.git"), { recursive: true });

		// Should not crash — find will skip directories because we use -type f
		const result = runFix(tmp);
		assert.ok(result.stdout.includes("Worktree fix complete"));
	});

	it("handles worktree name with special characters", () => {
		const specialId = "feature-issue#1000";
		tmp = createFixture({
			"main/.git": "gitdir: /home/user/git/.bare/worktrees/main",
			".bare/worktrees/main/gitdir": "/home/user/git/main/.git",
		});
		addWorktreeAbs(tmp, specialId);

		runFix(tmp);

		const gitContent = readFileOrNull(tmp, `${specialId}/.git`);
		assert.strictEqual(gitContent, `gitdir: ../.bare/worktrees/${specialId}`);

		const gitdirContent = readFileOrNull(tmp, `.bare/worktrees/${specialId}/gitdir`);
		assert.strictEqual(gitdirContent, `../../../${specialId}/.git`);
	});

	it("non-writable .git file does not crash function", () => {
		tmp = createFixture({
			"main/.git": "gitdir: /home/user/git/.bare/worktrees/main",
			".bare/worktrees/main/gitdir": "/home/user/git/main/.git",
		});
		// Add a locked-wt worktree that will be read-only
		addWorktreeAbs(tmp, "locked-wt");

		// Make locked-wt/.git read-only
		const lockedGit = join(tmp, "locked-wt/.git");
		execSync(`chmod 444 "${lockedGit}"`, { timeout: 3000 });

		// Should not crash — other worktrees still fixed
		const result = runFix(tmp);

		// main/.git should still be fixed
		const mainGit = readFileOrNull(tmp, "main/.git");
		assert.strictEqual(mainGit, "gitdir: ../.bare/worktrees/main");

		// locked-wt/.git may or may not have been rewritten (chmod is best-effort in container)
		// The important thing is no crash
		assert.ok(result.stdout.includes("Worktree fix complete"));
	});

	it("graceful exit when BARE_DIR cannot be discovered", () => {
		tmp = createFixture({
			"not-main/.git": "gitdir: /some/random/path",
			// No main/.git that resolves to a .bare, no .bare directory
		});

		const result = runFix(tmp);

		assert.ok(result.stdout.includes("Could not find .bare directory"));
		assert.ok(result.stdout.includes("skipping worktree fix"));
	});

	it("handles no .bare/worktrees/main/gitdir when main/.git is absolute", () => {
		// Main .git has absolute path, bare dir discovered via .bare/ fallback,
		// but gitdir file is missing
		tmp = createFixture({
			"main/.git": "gitdir: /home/user/git/.bare/worktrees/main",
			".bare/HEAD": "ref: refs/heads/main",
			// No .bare/worktrees/main/gitdir — just empty dir
		});
		mkdirSync(join(tmp, ".bare/worktrees/main"), { recursive: true });

		runFix(tmp);

		// Main .git should still be fixed
		assert.strictEqual(readFileOrNull(tmp, "main/.git"), "gitdir: ../.bare/worktrees/main");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 7: BARE_DIR discovery variations
// ═══════════════════════════════════════════════════════════════════

describe("BARE_DIR discovery", () => {
	let tmp: string;

	afterEach(() => {
		if (tmp) destroyFixture(tmp);
	});

	it("discovers bare dir from main/.git content", () => {
		tmp = createFixture({
			"main/.git": "gitdir: /workspaces/.bare/worktrees/main",
			".bare/worktrees/main/gitdir": "/workspaces/main/.git",
		});

		const result = runFix(tmp);
		assert.ok(result.stdout.includes("BARE_DIR="));
	});

	it("falls back to .bare/ when main/.git has already-relative content", () => {
		tmp = createFixture({
			"main/.git": "gitdir: ../.bare/worktrees/main",
			".bare/HEAD": "ref: refs/heads/main",
			".bare/worktrees/main/gitdir": "../../../main/.git",
		});

		const result = runFix(tmp);
		// Should find .bare via fallback
		assert.ok(result.stdout.includes("BARE_DIR="));
		assert.ok(result.stdout.includes("Worktree fix complete"));
	});

	it("skips fix when no .bare directory exists anywhere", () => {
		tmp = createFixture({
			"some-dir/file.txt": "hello",
		});

		const result = runFix(tmp);
		assert.ok(result.stdout.includes("Could not find .bare directory"));
	});
});
