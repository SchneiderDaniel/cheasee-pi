// ─── Phase 13: user journey ──────────────────────────────────────
// Persona: a repository maintainer runs a long coding goal across a context
// rollover and a Pi restart. Real store, real git workspace, real service;
// fake agent sessions, checks and GitHub. Every user-visible string is
// asserted verbatim.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalService, type GoalServiceDeps } from "../application/goal-service.ts";
import { MarkdownGoalStore } from "../adapters/markdown-goal-store.ts";
import { GitGoalWorkspace } from "../adapters/git-goal-workspace.ts";
import { GOAL_COMMAND, registerGoalLoop } from "../index.ts";
import type { GoalRuntimeConfig } from "../application/goal-service.ts";
import { realGit, realGitExec } from "../../supervisor/test/helpers/git-harness.mts";
import { createRecordingPi, createUiCtx, type RecordingPi } from "./helpers/recording-pi.mts";
import {
	createCallLog,
	FakeCheckRunner,
	FakeGoalRuntime,
	FakePullRequestPort,
} from "./helpers/fake-ports.mts";
import { commandCriterion } from "./helpers/builders.mts";

interface Journey {
	root: string;
	checkout: string;
	worktreeBase: string;
	cleanup: () => void;
}

async function makeRepo(): Promise<Journey> {
	const root = mkdtempSync(join(tmpdir(), "goal-journey-"));
	const checkout = join(root, "checkout");
	await realGit(root, ["init", "-b", "main", "checkout"]);
	await realGit(checkout, ["config", "user.email", "test@example.com"]);
	await realGit(checkout, ["config", "user.name", "Test"]);
	writeFileSync(join(checkout, "README.md"), "base\n");
	writeFileSync(join(checkout, ".gitignore"), "ignore/\n");
	await realGit(checkout, ["add", "."]);
	await realGit(checkout, ["commit", "-m", "base"]);
	return {
		root,
		checkout,
		worktreeBase: join(root, "worktrees"),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

interface Wired {
	recording: RecordingPi;
	ui: ReturnType<typeof createUiCtx>;
	service: GoalService;
	store: MarkdownGoalStore;
	checks: FakeCheckRunner;
	pr: FakePullRequestPort;
	runtime: FakeGoalRuntime;
}

function wire(repo: Journey): Wired {
	const log = createCallLog();
	const store = new MarkdownGoalStore(repo.checkout);
	const checks = new FakeCheckRunner(log);
	const pr = new FakePullRequestPort(log);
	const runtime = new FakeGoalRuntime(log);
	const config: GoalRuntimeConfig = {
		settings: { model: "provider/model-id", contextRolloverTokens: 150_000, maxIterations: 50 },
		model: {
			ref: "provider/model-id",
			id: "model-id",
			provider: "provider",
			contextWindow: 400_000,
		},
	};
	const ui = createUiCtx(repo.checkout);
	const deps: GoalServiceDeps = {
		store,
		workspace: new GitGoalWorkspace({
			checkoutRoot: repo.checkout,
			worktreeBase: repo.worktreeBase,
			exec: realGitExec(repo.checkout),
		}),
		pr,
		runtime,
		checks,
		loadConfig: () => ({ ok: true, value: config }),
		notify: {
			info: (message) => ui.notifications.push({ message, type: "info" }),
			error: (message) => ui.notifications.push({ message, type: "error" }),
		},
		baseBranch: async () => ({ ok: true, value: "main" }),
		repo: "owner/repo",
	};
	const service = new GoalService(deps);
	const recording = createRecordingPi();
	registerGoalLoop(recording.pi, {
		resolveBackend: async () => ({ ok: true, value: { service, runtime } }),
	});
	return { recording, ui, service, store, checks, pr, runtime };
}

function messages(wired: Wired): string[] {
	return wired.ui.notifications.map((n) => n.message);
}

describe("user journey: maintainer runs a verified goal", () => {
	it("walks the whole loop, including a rollover and a restart", async () => {
		const repo = await makeRepo();
		try {
			const wired = wire(repo);

			// ── 1. Dirty checkout ──────────────────────────────────
			writeFileSync(join(repo.checkout, "README.md"), "modified but uncommitted\n");
			const dirtyContent = readFileSync(join(repo.checkout, "README.md"), "utf-8");

			await wired.recording.runCommand(GOAL_COMMAND, "add a verified goal loop", wired.ui.ctx);
			assert.ok(messages(wired).some((m) => /recorded as clarifying/.test(m)));

			await wired.recording.runCommand(GOAL_COMMAND, "status", wired.ui.ctx);
			assert.ok(messages(wired).some((m) => /no active goal|clarifying/.test(m)));

			const clarification = await wired.recording.tools.get("goal_submit_clarification")!.execute(
				{},
				{
					ready: true,
					clarifiedGoal: "add a verified goal loop",
					criteria: [commandCriterion("c1", ["npm", "test"])],
				},
				undefined,
				undefined,
				wired.ui.ctx,
			);

			assert.ok(
				messages(wired).some((m) => /commit or stash/i.test(m)),
				"the user is told to commit or stash",
			);
			assert.equal(
				readFileSync(join(repo.checkout, "README.md"), "utf-8"),
				dirtyContent,
				"the dirty working tree is untouched",
			);
			assert.equal(existsSync(wired.service.current()!.worktree ?? ""), false);
			assert.equal(wired.service.current()!.status, "paused");
			assert.match(
				String((clarification as { content: Array<{ text: string }> }).content[0]!.text),
				/clarification|goal/,
			);

			// ── 2. Stop the paused goal, then stash ────────────────
			await wired.recording.runCommand(GOAL_COMMAND, "stop", wired.ui.ctx);
			assert.ok(messages(wired).some((m) => /goal stopped/.test(m)));
			assert.equal(wired.service.current()!.status, "cancelled");
			await realGit(repo.checkout, ["stash", "push", "-m", "wip"]);

			// ── 3. A vague goal asks focused questions ─────────────
			await wired.recording.runCommand(GOAL_COMMAND, "make it better", wired.ui.ctx);
			const clarifying = wired.service.current()!;
			assert.equal(clarifying.status, "clarifying");
			assert.equal(
				existsSync(join(repo.checkout, "ignore/goals", `${clarifying.id}.md`)),
				true,
				"a Markdown record exists under ignore/goals",
			);
			assert.equal(clarifying.worktree, null, "no worktree yet");

			const questions = await wired.recording.tools.get("goal_submit_clarification")!.execute(
				{},
				{
					ready: false,
					questions: ["1?", "2?", "3?", "4?", "5?", "6?", "7?"],
				},
				undefined,
				undefined,
				wired.ui.ctx,
			);
			const questionText = (questions as { content: Array<{ text: string }> }).content[0]!.text;
			assert.match(questionText, /clarification incomplete/);
			assert.ok(
				questionText.split("\n").filter((line) => line.startsWith("- ")).length <= 5,
				"at most five focused questions",
			);

			// Settling after asking for clarification must not run a work boundary.
			await assert.doesNotReject(() =>
				wired.recording.emit("agent_before_settle", {}, wired.ui.ctx),
			);
			assert.equal(wired.service.current()!.status, "clarifying");
			assert.equal(wired.service.current()!.iterations, 0);

			// ── 4. Answering starts work with no extra confirmation ─
			await wired.recording.tools.get("goal_submit_clarification")!.execute(
				{},
				{
					ready: true,
					clarifiedGoal: "raise coverage of module x to 90%",
					criteria: [commandCriterion("c1", ["npm", "test"])],
				},
				undefined,
				undefined,
				wired.ui.ctx,
			);
			const started = wired.service.current()!;
			assert.equal(started.status, "active");
			const worktreePath = join(repo.worktreeBase, started.id);
			assert.equal(started.worktree, worktreePath);
			assert.equal(started.branch, `goal/${started.id}`);
			const startedMessage = messages(wired).find((m) => /started/.test(m))!;
			assert.match(startedMessage, new RegExp(`worktree ${worktreePath}`));
			assert.match(startedMessage, new RegExp(`branch goal/${started.id}`));
			assert.equal(
				wired.ui.notifications.filter((n) => /confirm|approve/i.test(n.message)).length,
				0,
			);

			// ── 5. First iteration publishes a draft PR ────────────
			await wired.recording.runCommand(GOAL_COMMAND, "status", wired.ui.ctx);
			const beforeIteration = messages(wired).at(-1)!;
			assert.match(beforeIteration, /iterations: 0/);

			const continued = await wired.recording.emit("agent_before_settle", {}, wired.ui.ctx);
			assert.deepEqual(continued, { continue: true });

			await wired.recording.runCommand(GOAL_COMMAND, "status", wired.ui.ctx);
			const status = messages(wired).at(-1)!;
			assert.match(status, /iterations: 1/);
			assert.match(status, /resets: 0/);
			assert.match(status, /c1: pass/);
			assert.match(status, new RegExp(`worktree: ${worktreePath}`));
			assert.match(status, new RegExp(`branch: goal/${started.id}`));
			assert.match(status, /pull request: #7 \(draft\)/);
			assert.ok(messages(wired).some((m) => /draft PR #7 opened/.test(m)));

			// ── 6. The context threshold rolls over ────────────────
			wired.checks.results.set("c1", "fail");
			wired.runtime.tokens = 200_000;
			await wired.recording.emit("agent_before_settle", {}, wired.ui.ctx);
			assert.ok(
				messages(wired).some((m) => m === "checkpoint saved, fresh session started (reset 1)"),
				"the rollover is announced verbatim",
			);

			await wired.recording.runCommand(GOAL_COMMAND, "status", wired.ui.ctx);
			const afterRollover = messages(wired).at(-1)!;
			assert.match(afterRollover, /resets: 1/);
			assert.match(afterRollover, /iterations: 2/);
			assert.match(afterRollover, new RegExp(`worktree: ${worktreePath}`), "same worktree");
			assert.equal(wired.runtime.starts.length, 2);

			// ── 7. A second goal is rejected, stop prints the final state ──
			await wired.recording.runCommand(GOAL_COMMAND, "second goal while busy", wired.ui.ctx);
			const rejection = messages(wired).find((m) => /already active/.test(m))!;
			assert.match(rejection, new RegExp(started.id));

			await wired.recording.runCommand(GOAL_COMMAND, "stop", wired.ui.ctx);
			const stopped = messages(wired).at(-1)!;
			assert.match(stopped, /goal stopped/);
			assert.match(stopped, /status: cancelled/);
			assert.equal(wired.service.hasActiveGoal(), false);

			// ── 8. After a Pi restart the record is still there ────
			const recordPath = join(repo.checkout, "ignore/goals", `${started.id}.md`);
			assert.equal(existsSync(recordPath), true);
			const restarted = new MarkdownGoalStore(repo.checkout);
			const reloaded = await restarted.read(started.id);
			assert.equal(reloaded.ok, true);
			if (!reloaded.ok) return;
			assert.equal(reloaded.value.status, "cancelled");
			assert.ok(
				reloaded.value.lastCheckpoint.length > 0,
				"the last checkpoint survives the restart",
			);
			assert.equal(reloaded.value.iterations, 2);
			assert.equal(reloaded.value.resets, 1);

			assert.doesNotThrow(() =>
				execFileSync("git", ["check-ignore", recordPath], { cwd: repo.checkout }),
			);
			const porcelain = execFileSync("git", ["status", "--porcelain"], {
				cwd: repo.checkout,
				encoding: "utf-8",
			});
			assert.equal(porcelain.trim(), "", "the record is never tracked");
		} finally {
			repo.cleanup();
		}
	});

	it("reports an unambiguous error when goalLoop configuration is missing", async () => {
		const repo = await makeRepo();
		try {
			const wired = wire(repo);
			const failing = new GoalService({
				...({} as GoalServiceDeps),
				store: new MarkdownGoalStore(repo.checkout),
				workspace: {
					prepare: async () => ({ ok: true, value: { clean: false, reason: "unused" } }),
					discardGoalWorktree: async () => ({ ok: true, value: undefined }),
				},
				pr: wired.pr,
				runtime: wired.runtime,
				checks: wired.checks,
				loadConfig: () => ({
					ok: false,
					error: 'no "goalLoop" key in .pi/settings.json',
					source: "goalLoop",
				}),
				baseBranch: async () => ({ ok: true, value: "main" }),
				repo: "owner/repo",
			});
			const recording = createRecordingPi();
			registerGoalLoop(recording.pi, {
				resolveBackend: async () => ({ ok: true, value: { service: failing } }),
			});
			const ui = createUiCtx(repo.checkout);

			await recording.runCommand(GOAL_COMMAND, "ship it", ui.ctx);
			const error = ui.notifications.find((n) => n.type === "error");
			assert.ok(error);
			assert.match(error!.message, /goalLoop/);
			assert.equal(existsSync(join(repo.checkout, "ignore/goals")), false);
		} finally {
			repo.cleanup();
		}
	});
});
