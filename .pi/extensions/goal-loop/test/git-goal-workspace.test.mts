// ─── Phase 9: git goal workspace adapter ─────────────────────────
// R3.AC2/AC5 against REAL git in temp repos: the clean-checkout gate, the
// HEAD-based worktree, the no-tmpdir-fallback rule, and cleanup that never
// happens without explicit confirmation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitGoalWorkspace } from "../adapters/git-goal-workspace.ts";
import { realGit, realGitExec } from "../../supervisor/test/helpers/git-harness.mts";

interface Repo {
	root: string;
	dir: string;
	worktreeBase: string;
	cleanup: () => void;
}

async function makeRepo(): Promise<Repo> {
	const root = mkdtempSync(join(tmpdir(), "goal-git-"));
	const dir = join(root, "checkout");
	const worktreeBase = join(root, "worktrees");
	await realGit(root, ["init", "-b", "main", "checkout"]);
	await realGit(dir, ["config", "user.email", "test@example.com"]);
	await realGit(dir, ["config", "user.name", "Test"]);
	writeFileSync(join(dir, "README.md"), "base\n");
	writeFileSync(join(dir, ".gitignore"), "ignore/\n");
	await realGit(dir, ["add", "."]);
	await realGit(dir, ["commit", "-m", "base"]);
	return { root, dir, worktreeBase, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function head(repo: Repo): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf-8" }).trim();
}

function worktreeList(repo: Repo): string {
	return execFileSync("git", ["worktree", "list", "--porcelain"], {
		cwd: repo.dir,
		encoding: "utf-8",
	});
}

const GOAL_ID = "20260102-030405-add-a-feature-abcd";
const BRANCH = "goal/20260102-030405-add-a-feature-abcd";

describe("GitGoalWorkspace.prepare", () => {
	it("creates a worktree whose HEAD equals the original checkout's HEAD", async () => {
		const repo = await makeRepo();
		try {
			const workspace = new GitGoalWorkspace({
				checkoutRoot: repo.dir,
				worktreeBase: repo.worktreeBase,
				exec: realGitExec(repo.dir),
			});

			const prepared = await workspace.prepare({ goalId: GOAL_ID, branch: BRANCH });
			assert.equal(prepared.ok, true);
			if (!prepared.ok) return;
			assert.equal(prepared.value.clean, true);
			if (!prepared.value.clean) return;

			assert.equal(prepared.value.head, head(repo));
			const worktreeHead = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: prepared.value.path,
				encoding: "utf-8",
			}).trim();
			assert.equal(worktreeHead, head(repo), "the worktree starts at HEAD, not at a remote ref");
			assert.match(worktreeList(repo), new RegExp(BRANCH));
		} finally {
			repo.cleanup();
		}
	});

	it("refuses a dirty checkout and leaves the changes untouched", async () => {
		const repo = await makeRepo();
		try {
			writeFileSync(join(repo.dir, "README.md"), "modified\n");
			writeFileSync(join(repo.dir, "untracked.txt"), "new\n");
			const workspace = new GitGoalWorkspace({
				checkoutRoot: repo.dir,
				worktreeBase: repo.worktreeBase,
				exec: realGitExec(repo.dir),
			});

			const prepared = await workspace.prepare({ goalId: GOAL_ID, branch: BRANCH });
			assert.equal(prepared.ok, true);
			if (!prepared.ok) return;
			assert.equal(prepared.value.clean, false);
			if (prepared.value.clean) return;
			assert.match(prepared.value.reason, /commit or stash/i);

			const tracked = execFileSync("git", ["diff", "--name-only"], {
				cwd: repo.dir,
				encoding: "utf-8",
			});
			assert.match(tracked, /README\.md/, "the modified file is still modified");
			assert.equal(worktreeList(repo).includes(BRANCH), false, "no branch or worktree was created");
		} finally {
			repo.cleanup();
		}
	});

	it("refuses a detached HEAD and names it", async () => {
		const repo = await makeRepo();
		try {
			await realGit(repo.dir, ["checkout", "--detach"]);
			const workspace = new GitGoalWorkspace({
				checkoutRoot: repo.dir,
				worktreeBase: repo.worktreeBase,
				exec: realGitExec(repo.dir),
			});

			const prepared = await workspace.prepare({ goalId: GOAL_ID, branch: BRANCH });
			assert.equal(prepared.ok, true);
			if (!prepared.ok) return;
			assert.equal(prepared.value.clean, false);
			if (prepared.value.clean) return;
			assert.match(prepared.value.reason, /detached HEAD/);
			assert.equal(worktreeList(repo).includes(BRANCH), false);
		} finally {
			repo.cleanup();
		}
	});

	it("fails closed on an unwritable worktree base instead of falling back to tmpdir", async () => {
		const repo = await makeRepo();
		try {
			const blocked = join(repo.root, "blocked");
			writeFileSync(blocked, "not a directory\n");
			const workspace = new GitGoalWorkspace({
				checkoutRoot: repo.dir,
				worktreeBase: blocked,
				exec: realGitExec(repo.dir),
			});

			const prepared = await workspace.prepare({ goalId: GOAL_ID, branch: BRANCH });
			assert.equal(prepared.ok, false);
			if (!prepared.ok) assert.match(prepared.error, /not writable|worktree base/);
			assert.equal(worktreeList(repo).includes(BRANCH), false);
			assert.equal(
				worktreeList(repo).includes(GOAL_ID),
				false,
				"no worktree was created under any fallback base",
			);
		} finally {
			repo.cleanup();
		}
	});

	it("returns git's own stderr when the branch is already checked out elsewhere", async () => {
		const repo = await makeRepo();
		try {
			const workspace = new GitGoalWorkspace({
				checkoutRoot: repo.dir,
				worktreeBase: repo.worktreeBase,
				exec: realGitExec(repo.dir),
			});
			const first = await workspace.prepare({ goalId: GOAL_ID, branch: BRANCH });
			assert.equal(first.ok, true);

			const second = await workspace.prepare({ goalId: `${GOAL_ID}-two`, branch: BRANCH });
			assert.equal(second.ok, false);
			if (!second.ok) assert.match(second.error, /already|checked out|failed/i);
		} finally {
			repo.cleanup();
		}
	});
});

describe("GitGoalWorkspace.cleanupWorktree", () => {
	it("refuses to remove without explicit confirmation", async () => {
		const repo = await makeRepo();
		try {
			const workspace = new GitGoalWorkspace({
				checkoutRoot: repo.dir,
				worktreeBase: repo.worktreeBase,
				exec: realGitExec(repo.dir),
			});
			const prepared = await workspace.prepare({ goalId: GOAL_ID, branch: BRANCH });
			assert.equal(prepared.ok, true);
			if (!prepared.ok || !prepared.value.clean) return;

			const refused = await workspace.cleanupWorktree({
				path: prepared.value.path,
				confirmed: false,
			});
			assert.equal(refused.ok, false);
			if (!refused.ok) assert.match(refused.error, /retained/);
			assert.match(worktreeList(repo), new RegExp(BRANCH));
		} finally {
			repo.cleanup();
		}
	});

	it("removes the worktree when confirmed and reports the branch as retained", async () => {
		const repo = await makeRepo();
		try {
			const workspace = new GitGoalWorkspace({
				checkoutRoot: repo.dir,
				worktreeBase: repo.worktreeBase,
				exec: realGitExec(repo.dir),
			});
			const prepared = await workspace.prepare({ goalId: GOAL_ID, branch: BRANCH });
			assert.equal(prepared.ok, true);
			if (!prepared.ok || !prepared.value.clean) return;

			const removed = await workspace.cleanupWorktree({
				path: prepared.value.path,
				confirmed: true,
			});
			assert.equal(removed.ok, true);
			assert.equal(worktreeList(repo).includes(BRANCH), false);

			const branches = execFileSync("git", ["branch", "--list", BRANCH], {
				cwd: repo.dir,
				encoding: "utf-8",
			});
			assert.match(branches, /goal\//, "the branch is retained until an explicit decision");
		} finally {
			repo.cleanup();
		}
	});

	it("refuses to remove a path outside the worktree base", async () => {
		const repo = await makeRepo();
		try {
			const workspace = new GitGoalWorkspace({
				checkoutRoot: repo.dir,
				worktreeBase: repo.worktreeBase,
				exec: realGitExec(repo.dir),
			});
			const refused = await workspace.cleanupWorktree({ path: repo.dir, confirmed: true });
			assert.equal(refused.ok, false);
			assert.equal(worktreeList(repo).includes(repo.dir), true);
		} finally {
			repo.cleanup();
		}
	});

	it("does not clean up a merged or closed PR on its own", async () => {
		const repo = await makeRepo();
		try {
			const workspace = new GitGoalWorkspace({
				checkoutRoot: repo.dir,
				worktreeBase: repo.worktreeBase,
				exec: realGitExec(repo.dir),
			});
			const prepared = await workspace.prepare({ goalId: GOAL_ID, branch: BRANCH });
			assert.equal(prepared.ok, true);
			if (!prepared.ok || !prepared.value.clean) return;

			// The workspace has no PR awareness at all: nothing can trigger cleanup.
			assert.equal(
				typeof (workspace as unknown as { onPrMerged?: unknown }).onPrMerged,
				"undefined",
			);
			assert.match(worktreeList(repo), new RegExp(BRANCH));
		} finally {
			repo.cleanup();
		}
	});
});
