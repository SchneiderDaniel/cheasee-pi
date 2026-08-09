// ─── Integration tests: rebase mergeFallback option (issue #1473) ──
// Real-git fixture: mktemp bare remote + worktree + divergent same-file
// commits. Verifies that with mergeFallback:false a conflicted rebase is
// aborted cleanly (no merge commit, no MERGE_HEAD, HEAD restored, autostash
// restored), while default opts still produce the fallback merge commit
// (characterization of the pollution the option removes).
//
// Divergence shape (rebase-fail / merge-succeed window):
//   - feat:  C1 changes line5 → C2 reverts line5 (net: no change at line5)
//   - main:  changes line6 (adjacent to C1's change)
// Rebase replays C1 first — its per-commit 3-way merge sees adjacent-line
// changes (ours line6 vs theirs line5) → conflict. The whole-branch merge
// sees ours unchanged at line5 and only-theirs at line6 → clean merge.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { tryRebaseOntoBase } from "../../pipeline/rebase.ts";
import { hasBranchCommits } from "../../pipeline/stages/index.ts";

const execFileP = promisify(execFile);

/** Minimal ExtensionAPI whose exec shells out to real git. */
function realGitPi(defaultCwd: string): ExtensionAPI {
	return {
		exec: (async (
			cmd: string,
			args: string[],
			opts?: { cwd?: string; timeout?: number },
		) => {
			try {
				const { stdout } = await execFileP(cmd, args, {
					cwd: opts?.cwd ?? defaultCwd,
					timeout: opts?.timeout ?? 15_000,
					encoding: "utf-8",
					maxBuffer: 10 * 1024 * 1024,
				});
				return { code: 0, stdout, stderr: "" };
			} catch (err: unknown) {
				const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
				return {
					code: typeof e.code === "number" && e.code !== 0 ? e.code : 1,
					stdout: e.stdout ?? "",
					stderr: e.stderr ?? e.message ?? String(err),
				};
			}
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function run(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, encoding: "utf-8", timeout: 20_000 }).trim();
}

const isCI = process.env.CI === "true";

describe("rebase mergeFallback real git integration", { skip: !isCI, concurrency: false }, () => {
	let tmpDir: string;
	let mainDir: string;
	let wtDir: string;
	const branchName = "rebase-fallback-feat";
	const sharedFile = "shared.txt";
	const trackedDirtyFile = "notes.txt";

	it("setup: bare remote + main + divergent feature worktree", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "rebase-fallback-"));
		const bareDir = join(tmpDir, "bare.git");
		mainDir = join(tmpDir, "main");
		wtDir = join(tmpDir, "worktree");

		run(`git init --bare -b main "${bareDir}"`, tmpDir);
		run(`git clone "${bareDir}" "${mainDir}"`, tmpDir);

		// Initial commit: 10-line shared file + a tracked dirty-file candidate
		const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
		writeFileSync(join(mainDir, sharedFile), lines.join("\n") + "\n");
		writeFileSync(join(mainDir, trackedDirtyFile), "clean\n");
		run("git add -A", mainDir);
		run("git commit -m 'initial'", mainDir);
		run("git push origin main", mainDir);

		// Feature branch from main, pushed, worktree checked out
		run(`git branch "${branchName}"`, mainDir);
		run(`git push origin "${branchName}"`, mainDir);
		run(`git worktree add "${wtDir}" "${branchName}"`, mainDir);

		// C1: change line 5
		run(`sed -i '5s/line5/X5/' "${sharedFile}"`, wtDir);
		run("git add -A", wtDir);
		run("git commit -m 'feat: change line5'", wtDir);
		// C2: revert line 5 (net: no change at line5 on the branch)
		run(`sed -i '5s/X5/line5/' "${sharedFile}"`, wtDir);
		run("git add -A", wtDir);
		run("git commit -m 'feat: revert line5'", wtDir);

		// Main: change line 6 (adjacent to C1's line5 change)
		run(`sed -i '6s/line6/Y6/' "${sharedFile}"`, mainDir);
		run("git add -A", mainDir);
		run("git commit -m 'main: change line6'", mainDir);
		run("git push origin main", mainDir);
	});

	it("mergeFallback:false → abort cleanly: no merge commit, no MERGE_HEAD, HEAD restored, autostash restored", async () => {
		// Dirty change to a TRACKED file (real --autostash round-trip)
		run(`echo dirty > "${trackedDirtyFile}"`, wtDir);

		const preRebaseHead = run("git rev-parse HEAD", wtDir);
		const pi = realGitPi(wtDir);
		const result = await tryRebaseOntoBase(wtDir, "main", "origin", pi, {
			mergeFallback: false,
		});

		assert.ok(!result.success, "C1 replay must conflict on rebase");
		assert.ok(
			result.conflictFiles.includes(sharedFile),
			`conflictFiles should include ${sharedFile}, got: ${result.conflictFiles.join(", ")}`,
		);

		// No merge commit in branch history
		const log = run("git log --oneline --merges", wtDir);
		assert.equal(log, "", `no merge commits expected, got: ${log}`);

		// No MERGE_HEAD left behind
		const mergeHead = run("git rev-parse --verify MERGE_HEAD 2>/dev/null || echo none", wtDir);
		assert.equal(mergeHead, "none", "MERGE_HEAD must not exist after abort");

		// HEAD back at the pre-rebase commit
		const postRebaseHead = run("git rev-parse HEAD", wtDir);
		assert.equal(postRebaseHead, preRebaseHead, "HEAD should be restored by rebase --abort");

		// Autostashed dirty change restored (tracked file, real stash round-trip)
		const dirtyContent = run(`cat "${trackedDirtyFile}"`, wtDir);
		assert.equal(dirtyContent, "dirty", "autostashed dirty change must be restored after abort");
		const stashList = run("git stash list", wtDir);
		assert.equal(stashList, "", "stash list should be empty after autostash round-trip");

		// hasBranchCommits sees exactly the developer's two commits — no commit
		// attributable to the failed rebase (Bug #1343 classifier not polluted)
		const execFn = (cmd: string, args: string[], opts?: Record<string, unknown>) =>
			pi.exec(cmd, args, opts);
		const count = run(`git rev-list --count origin/main..${branchName}`, wtDir);
		assert.equal(parseInt(count, 10), 2, `exactly the 2 feature commits expected, got: ${count}`);
		const hasCommits = await hasBranchCommits(execFn, wtDir, branchName, "origin/main");
		assert.equal(hasCommits, true, "hasBranchCommits sees the real developer commits");
	});

	it("default opts → fallback merge commit present in branch history (pollution characterization)", async () => {
		// The previous test aborted the rebase, so the feature branch is still
		// at its divergent commits — re-run with default opts directly.
		const pi = realGitPi(wtDir);
		const result = await tryRebaseOntoBase(wtDir, "main", "origin", pi);

		assert.ok(result.success, "default opts should resolve via the merge fallback");
		assert.deepEqual(result.conflictFiles, []);
		assert.ok(
			result.message.includes("merge fallback succeeded"),
			"message should report the merge fallback success",
		);

		// Fallback merge commit present in branch history
		const merges = run("git log --oneline --merges", wtDir);
		assert.ok(merges.includes("Merge"), `fallback merge commit expected, got: ${merges}`);
		// hasBranchCommits would count the merge commit as a branch commit
		const count = run(`git rev-list --count origin/main..${branchName}`, wtDir);
		assert.ok(parseInt(count, 10) >= 3, `C1 + C2 + merge expected, got: ${count}`);
	});

	it("cleanup: remove worktree and temp dir", () => {
		if (wtDir) {
			try {
				run(`git worktree remove --force "${wtDir}"`, mainDir);
			} catch {
				// non-fatal
			}
		}
		if (mainDir) {
			try {
				run(`git branch -D "${branchName}"`, mainDir);
			} catch {
				// non-fatal
			}
		}
		if (tmpDir) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// non-fatal
			}
		}
	});
});
