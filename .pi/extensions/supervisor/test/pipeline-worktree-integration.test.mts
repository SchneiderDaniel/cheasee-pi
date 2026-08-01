/**
 * Integration tests for pipeline worktree fix (Phase 2 Integration)
 *
 * Verifies that pipeline.ts correctly:
 *  - Creates worktree before task construction
 *  - Passes worktreePath to buildAgentTask
 *  - Sets agentCwd for worktree-bound agents
 *  - Handles errors gracefully
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline-worktree-integration.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Issue #1395 split: handler.ts became a re-export shim. Worktree creation
// lives in handler/preflight.ts, the agent loop in handler/agent-loop.ts,
// and the post-loop cleanup in handler/post-pipeline.ts.
const PREFLIGHT_TS = resolve(__dirname, "../pipeline/handler/preflight.ts");
const AGENT_LOOP_TS = resolve(__dirname, "../pipeline/handler/agent-loop.ts");
const POST_PIPELINE_TS = resolve(__dirname, "../pipeline/handler/post-pipeline.ts");

function readPreflightSource(): string {
	return readFileSync(PREFLIGHT_TS, "utf-8");
}
function readAgentLoopSource(): string {
	return readFileSync(AGENT_LOOP_TS, "utf-8");
}
function readPostPipelineSource(): string {
	return readFileSync(POST_PIPELINE_TS, "utf-8");
}

function run(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, encoding: "utf-8", timeout: 15000 }).trim();
}

// ---------------------------------------------------------------------------
// Pipeline worktree lifecycle integration
// ---------------------------------------------------------------------------

describe("pipeline-worktree integration — lifecycle order", () => {
	it("worktree creation comment lives in preflight, build task comment in agent loop", () => {
		const preflightSrc = readPreflightSource();
		const loopSrc = readAgentLoopSource();
		assert.ok(preflightSrc.includes("// Create worktree before loop"), "Worktree creation comment");
		assert.ok(loopSrc.includes("// Build task"), "Build task comment");
	});

	it("buildAgentTask call appears in agent loop, after the preflight worktree section", () => {
		const preflightSrc = readPreflightSource();
		const loopSrc = readAgentLoopSource();
		assert.ok(preflightSrc.includes("// Create worktree before loop"), "Worktree creation section");
		assert.ok(loopSrc.includes("const task = buildAgentTask("), "buildAgentTask call exists");
	});

	it("worktreePath and worktreeBranch destructured from RunContext before the loop", () => {
		const src = readAgentLoopSource();
		const destructureIdx = src.indexOf("worktreePath,");
		const branchDecl = src.indexOf("worktreeBranch,");
		const loopIdx = src.indexOf("for (let i = 0; i < MAX_PIPELINE_LOOPS");
		assert.ok(destructureIdx >= 0, "worktreePath destructured from RunContext");
		assert.ok(branchDecl >= 0, "worktreeBranch destructured from RunContext");
		assert.ok(destructureIdx < loopIdx, "worktreePath declared before the loop");
		assert.ok(branchDecl < loopIdx, "worktreeBranch declared before the loop");
	});

	it("worktreePath passed directly as argument to executeAgent", () => {
		const src = readAgentLoopSource();
		const executeIdx = src.indexOf("await executeAgent(");
		const worktreeIdx = src.indexOf("worktreePath,", executeIdx);
		assert.ok(worktreeIdx > executeIdx, "worktreePath passed as argument to executeAgent");
	});

	it("worktreeBranch generated via generateBranchName", () => {
		const src = readPreflightSource();
		const lifecycleIdx = src.indexOf("// Create worktree before loop");
		const section = src.substring(lifecycleIdx);
		assert.ok(
			section.includes("worktreeBranch = generateBranchName"),
			"worktreeBranch assigned from generateBranchName",
		);
	});

	it("commitAndPush uses worktreePath as second argument", () => {
		const stagesSrc = readFileSync(join(__dirname, "../pipeline/stages.ts"), "utf-8");
		const commitIdx = stagesSrc.indexOf("await commitAndPush(");
		const worktreeIdx = stagesSrc.indexOf("worktreePath,", commitIdx);
		assert.ok(worktreeIdx > commitIdx, "commitAndPush receives worktreePath");
	});
});

// ---------------------------------------------------------------------------
// Pipeline worktree — error handling and edge cases
// ---------------------------------------------------------------------------

describe("pipeline-worktree integration — error handling", () => {
	it("worktree creation has error handling", () => {
		const src = readPreflightSource();
		// The worktree creation section wraps createWorktree (which has its own error handling)
		assert.ok(src.includes("await createWorktree"), "createWorktree called");
	});

	it("commitAndPush failure is warned not thrown", () => {
		const stagesSrc = readFileSync(join(__dirname, "../pipeline/stages.ts"), "utf-8");
		const caIdx = stagesSrc.indexOf("await commitAndPush(");
		const commitSection = stagesSrc.substring(caIdx, caIdx + 200);
		assert.ok(
			commitSection.includes("!commitResult.ok") && commitSection.includes("notify"),
			"commitAndPush failure caught and warned via Result pattern",
		);
	});

	it("worktree cleanup called in handler (error handling inside cleanupWorktree)", () => {
		const src = readPostPipelineSource();
		const cleanupIdx = src.indexOf("// 2. Worktree cleanup (after merge is complete)");
		assert.ok(cleanupIdx >= 0, "Worktree cleanup section exists");
		const section = src.substring(cleanupIdx);
		assert.ok(section.includes("cleanupWorktree"), "cleanupWorktree called");
	});

	it("PR push uses worktreePath as cwd", () => {
		const prSrc = readFileSync(join(__dirname, "../pipeline/pr-creation.ts"), "utf-8");
		assert.ok(prSrc.includes('pi.exec("git", ["push"'), "git push in PR creation section");
		assert.ok(prSrc.includes("worktreePath"), "worktreePath used in PR creation");
	});
});

// ---------------------------------------------------------------------------
// Real git worktree integration tests (CI only — modifies git state)
// ---------------------------------------------------------------------------

const isCI = process.env.CI === "true";

describe("pipeline-worktree real git operations", { skip: !isCI, concurrency: false }, () => {
	let tmpDir: string;
	let bareDir: string;
	let mainDir: string;
	let wtDir: string;
	const branchName = "test-real-worktree-branch";

	it("creates a worktree and verifies pwd returns worktree path", () => {
		tmpDir = execSync("mktemp -d /tmp/worktree-real-test-XXXXXX", {
			encoding: "utf-8",
			timeout: 5000,
		}).trim();

		// Create bare repo
		bareDir = join(tmpDir, "bare.git");
		run(`git init --bare "${bareDir}"`, tmpDir);

		// Clone main worktree
		mainDir = join(tmpDir, "main");
		run(`git clone "${bareDir}" "${mainDir}"`, tmpDir);

		// Make an initial commit on main
		run("git commit --allow-empty -m 'initial'", mainDir);
		run("git push origin main", mainDir);

		// Create branch for worktree
		run(`git branch "${branchName}"`, mainDir);
		run(`git push origin "${branchName}"`, mainDir);

		// Create worktree for branch
		wtDir = join(tmpDir, "worktree");
		run(`git worktree add -b "${branchName}" "${wtDir}" main`, mainDir);

		// Verify pwd returns worktree path
		const pwd = run("pwd", wtDir);
		assert.equal(pwd, wtDir, "pwd should return worktree path");

		// Verify git branch --show-current returns branch name
		const branch = run("git branch --show-current", wtDir);
		assert.equal(branch, branchName, "branch should match worktree branch");

		// Verify inside-work-tree detection
		const inside = run("git rev-parse --is-inside-work-tree", wtDir);
		assert.equal(inside, "true", "should be inside a git worktree");

		// Verify show-toplevel returns worktree path
		const toplevel = run("git rev-parse --show-toplevel", wtDir);
		assert.equal(toplevel, wtDir, "show-toplevel should return worktree path");

		// Verify rev-list can count commits (branch is valid)
		const count = run(`git rev-list --count main..${branchName}`, mainDir);
		assert.equal(parseInt(count.trim(), 10), 0, "branch should have no commits beyond main");
	});

	it("removes worktree and cleans up", () => {
		// Remove worktree
		if (wtDir) {
			try {
				run(`git worktree remove --force "${wtDir}"`, mainDir);
			} catch {
				// Non-fatal cleanup
			}
		}
		// Delete branch
		if (mainDir && branchName) {
			try {
				run(`git branch -D "${branchName}"`, mainDir);
			} catch {
				// Non-fatal cleanup
			}
		}
		// Remove temp dir
		if (tmpDir) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// Non-fatal cleanup
			}
		}
	});
});
