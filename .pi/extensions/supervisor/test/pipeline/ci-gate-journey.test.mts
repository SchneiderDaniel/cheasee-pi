// ─── Journey: red CI returns to the developer, bounded (issue #1829) ──
// The developer persona's round trip: a failing check on the pushed commit
// comes back on the issue (no history rewrite), their fix push is polled at
// its own SHA and passes, and the loop cannot spin past the reject budget.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline/ci-gate-journey.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, FilteredIssueData } from "../../config/types.ts";
import type { RunContext } from "../../pipeline/handler/shared.ts";
import type { ExecFn } from "../../../lib/port-types.ts";
import { runCiGate, type PreGateDeps } from "../../pipeline/audit/pre-gates.ts";
import { uncommitDeveloperWork } from "../../pipeline/stages/audit-rejection-ops.ts";
import { postCiGateRejection } from "../../pipeline/stages/audit-rejection-ops.ts";
import { upsertDeveloperPr } from "../../pipeline/stages/git-ops.ts";
import { applyGateFailureContext, createStageState } from "../../pipeline/stages/index.ts";
import { loadLoopIssue } from "../../pipeline/handler/agent-loop-steps.ts";
import { REJECTION_LIMIT, WORKFLOW } from "../../config/workflow.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";
import type { GitHubPort } from "../../github/ports.ts";

// ─── Fixtures ─────────────────────────────────────────────────────

const CONFIG: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {},
	maxRejections: 3,
	codeowners: ["user1"],
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../worktrees",
	branchPrefix: "worktree-git-issue-",
	ciGatingTimeoutSec: 30,
	bellOnComplete: false,
	enableExperimentalFeatures: false,
	auditScoreThreshold: 0.75,
	vulnGateBlocking: false,
	vulnGateTimeoutSec: 60,
};

const ISSUE = 1829;
const WT = "/wt/issue-1829";
const BRANCH = "worktree-git-issue-1829-test";
const P1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const P2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";

interface ExecCall {
	cmd: string;
	args: string[];
}

/** A tiny fake CI + git remote: check conclusions are keyed by commit SHA. */
function makeWorld(conclusions: Record<string, string>) {
	const calls: ExecCall[] = [];
	const state = { headSha: P1 };
	const exec: ExecFn = async (cmd: string, args: string[]) => {
		const argv = (args ?? []).join(" ");
		calls.push({ cmd, args: [...(args ?? [])] });
		if (cmd === "gh" && argv.includes("/pulls?")) {
			return {
				code: 0,
				stdout: JSON.stringify([{ number: 7, head: { sha: state.headSha } }]),
				stderr: "",
			};
		}
		if (cmd === "gh" && argv.includes("/check-runs")) {
			const conclusion = conclusions[state.headSha] ?? "success";
			return {
				code: 0,
				stdout: JSON.stringify({ id: 1, name: "build", status: "completed", conclusion }),
				stderr: "",
			};
		}
		if (cmd === "git" && argv.startsWith("merge-base --is-ancestor")) {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "git" && argv.startsWith("rev-list")) {
			return { code: 0, stdout: "1", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const pi = {
		exec: (async (cmd: string, args: string[]) => exec(cmd, args ?? [])) as ExtensionAPI["exec"],
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	return { calls, state, exec, pi };
}

interface NotifyCall {
	message: string;
	level: string;
}

function makeUi(): { ui: ExtensionCommandContext["ui"]; notifyCalls: NotifyCall[] } {
	const notifyCalls: NotifyCall[] = [];
	return {
		notifyCalls,
		ui: {
			notify: (message: string, level: string) => notifyCalls.push({ message, level }),
			setStatus: () => {},
		} as unknown as ExtensionCommandContext["ui"],
	};
}

/** Recording GitHub port with live reject labels. */
function makePort(calls: PortCall[]): { port: GitHubPort; labels: () => string[] } {
	let labels: string[] = [];
	const port = createMockGitHubPort(
		{
			getIssueLabels: async () => [...labels],
			addIssueLabel: async (_issueNum: number, _repo: string, label: string) => {
				labels = [...labels.filter((l) => l !== label), label];
			},
			removeIssueLabel: async (_issueNum: number, _repo: string, label: string) => {
				labels = labels.filter((l) => l !== label);
			},
			listComments: async () => [],
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => ({ number: 7 }),
		},
		calls,
	);
	return { port, labels: () => [...labels] };
}

const resetCalls = (calls: ExecCall[]): ExecCall[] =>
	calls.filter((c) => c.args.join(" ").startsWith("reset --soft"));
const checkRunCalls = (calls: ExecCall[]): ExecCall[] =>
	calls.filter((c) => c.cmd === "gh" && c.args.join(" ").includes("/check-runs"));
const comments = (calls: PortCall[]): string[] =>
	calls.filter((c) => c.method === "postIssueComment").map((c) => String(c.args[2]));

const DATA: FilteredIssueData = { body: "body", comments: [] };
const IMPLEMENTATION_STEP = WORKFLOW.find((s) => s.status === "Implementation")!;

// ─── Phase 7a: one red check, then a green fix push ───────────────

describe("journey — developer fixes a red CI and the gate re-polls the new head (issue #1829)", () => {
	it("red build on P1 → issue comment naming build, no reset; fix push P2 → Audit", async () => {
		const { calls, state, exec, pi } = makeWorld({ [P1]: "failure", [P2]: "success" });
		const portCalls: PortCall[] = [];
		const { port, labels } = makePort(portCalls);
		const { ui, notifyCalls } = makeUi();
		const collector = new ErrorCollector();
		const deps: PreGateDeps = {
			pi,
			execFn: exec,
			ui,
			repo: CONFIG.repo,
			branch: BRANCH,
			filteredData: { body: "", comments: [] },
			issueTitle: "bounded CI loop-back",
		};

		// 1. The developer's run committed and pushed P1; the gate polls P1.
		const blocked = await runCiGate(deps, CONFIG, P1);
		assert.ok(blocked.failureText, "red CI blocks the transition");
		assert.equal(blocked.failureText!.split("\n")[0], "--- CI Gate (failing: build) ---");
		assert.equal(state.headSha, P1);
		assert.equal(checkRunCalls(calls).length, 1, "one poll of the pushed commit");

		// 2. The pushed commit must not be uncommitted.
		const uncommit = await uncommitDeveloperWork(exec, WT, CONFIG.remote!, BRANCH, ui, collector);
		assert.equal(uncommit, "skipped-on-remote");
		assert.deepEqual(resetCalls(calls), []);

		// 3. The developer sees the failing check on the issue.
		const counted = await postCiGateRejection(
			ISSUE,
			CONFIG,
			blocked.failureText!,
			2,
			collector,
			port,
			{ ui } as unknown as ExtensionCommandContext,
		);
		assert.equal(counted, 1);
		assert.equal(comments(portCalls).length, 1);
		assert.ok(comments(portCalls)[0]!.startsWith("## CI Gate Failed"));
		assert.ok(comments(portCalls)[0]!.includes("build"));
		assert.deepEqual(labels(), ["reject-1"]);

		// 4. The gate history is recorded for the PR body.
		const stageState = createStageState("Implementation");
		applyGateFailureContext(stageState, "Implementation", blocked.failureText!, 2);
		assert.deepEqual(stageState.gateFailureHistory, [
			"CI Gate (failing: build) gate failed on run 2 — developer restarted",
		]);

		// 5. The developer pushes P2; the gate re-polls the new head and passes.
		state.headSha = P2;
		const allowed = await runCiGate(deps, CONFIG, P2);

		assert.equal(allowed.failureText, null, "the fix push is green");
		const polls = checkRunCalls(calls);
		assert.equal(polls.length, 2);
		assert.ok(
			polls[1]!.args.join(" ").includes(`commits/${P2}/check-runs`),
			`the second poll targets the new head: ${polls[1]!.args.join(" ")}`,
		);

		// 6. The PR body carries the gate history (one entry, not duplicated).
		const pr = await upsertDeveloperPr({
			pi,
			issueNum: ISSUE,
			issueTitle: "bounded CI loop-back",
			config: CONFIG,
			worktreePath: WT,
			worktreeBranch: BRANCH,
			port,
			gateFailureHistory: stageState.gateFailureHistory,
		});
		assert.equal(pr.success, true);
		const create = portCalls.find((c) => c.method === "createPullRequest");
		assert.ok(create, "the PR was created");
		const body = String((create!.args[0] as { body?: string }).body ?? "");
		assert.equal(
			body.split("CI Gate (failing: build) gate failed on run 2").length - 1,
			1,
			"exactly one gate-history entry in the PR body",
		);
		assert.ok(notifyCalls.length > 0, "the operator was kept informed");
	});
});

// ─── Phase 7b: the loop is bounded ────────────────────────────────

describe("journey — five CI blocks exhaust the budget and stop the pipeline (issue #1829)", () => {
	it("the sixth dispatch never happens; reject-5 is the last label and the blocker is posted", async () => {
		const portCalls: PortCall[] = [];
		const { port, labels } = makePort(portCalls);
		const { ui } = makeUi();
		const collector = new ErrorCollector();

		for (let run = 1; run <= REJECTION_LIMIT; run++) {
			const next = await postCiGateRejection(
				ISSUE,
				CONFIG,
				"--- CI Gate (failing: build) ---\nCI checks failing: build.",
				run,
				collector,
				port,
				{ ui } as unknown as ExtensionCommandContext,
			);
			assert.equal(next, run, `run ${run} bumps the counter to ${run}`);
		}

		assert.deepEqual(labels(), [`reject-${REJECTION_LIMIT}`], "reject-5 is the last counter label");
		assert.equal(comments(portCalls).length, REJECTION_LIMIT, "one comment per block");

		// The next dispatch is refused and the blocker is posted on the issue.
		const runCtx = {
			ctx: { ui, cwd: "/repo" } as unknown as ExtensionCommandContext,
			exec: (async (cmd: string) =>
				cmd === "gh"
					? {
							code: 0,
							stdout: JSON.stringify({
								number: ISSUE,
								title: "bounded CI loop-back",
								body: "body",
								author: { login: "user1" },
								comments: [],
							}),
							stderr: "",
						}
					: { code: 0, stdout: "", stderr: "" }) as unknown as RunContext["exec"],
			config: CONFIG,
			issueNum: ISSUE,
			issueData: {},
			collector: new ErrorCollector(),
			port,
			stageState: createStageState("Implementation"),
		} as unknown as RunContext;
		runCtx.stageState.gateFailureContext =
			"--- CI Gate (failing: build) ---\nCI checks failing: build.";

		const resolution = await loadLoopIssue(runCtx, IMPLEMENTATION_STEP);

		assert.equal(resolution.kind, "terminal");
		assert.equal(
			(resolution as { stopReason: string }).stopReason,
			`Rejection limit reached (${REJECTION_LIMIT})`,
		);
		const blocker = comments(portCalls).at(-1)!;
		assert.ok(blocker.startsWith("## Rejection Limit Reached"), blocker);
		assert.ok(blocker.includes(String(REJECTION_LIMIT)), blocker);
		assert.ok(blocker.includes("CI Gate (failing: build)"), blocker);
	});
});
