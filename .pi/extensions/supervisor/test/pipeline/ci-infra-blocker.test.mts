/**
 * CI infrastructure failure stops the pipeline (issue #1830).
 *
 * Fail-closed means the pipeline must not complete when CI cannot be
 * verified — but an unreachable or slow CI is not a code defect, so it stops
 * with a blocker comment instead of looping the developer.
 *
 * Phase 4: orchestrator sequencing — `runTscAndLspAudit`
 * Phase 5: blocker poster — `postPipelineBlocker`
 * Phase 6: hook dispatch — `runPreTransitionHooks`
 * Phase 7: operator journey — `runAgentLoop`
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline/ci-infra-blocker.test.mts
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type {
	SupervisorConfig,
	AgentRunResult,
	ProjectField,
	ProjectItem,
} from "../../config/types.ts";
import type { GitHubPort } from "../../github/ports.ts";
import type { RunContext } from "../../pipeline/handler/shared.ts";
import type { StageState } from "../../pipeline/stages/index.ts";
import { createStageState } from "../../pipeline/stages/index.ts";
import { WORKFLOW } from "../../config/workflow.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import { runTscAndLspAudit, type AuditOrchestratorDeps } from "../../pipeline/audit/index.ts";
import { runPreTransitionHooks } from "../../pipeline/handler/agent-loop-helpers.ts";
import { postPipelineBlocker } from "../../pipeline/handler/blocker-comment.ts";
import { runAgentLoop } from "../../pipeline/handler/agent-loop.ts";
import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";

// ─── Fixtures ─────────────────────────────────────────────────────

const CONFIG: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {
		Backlog: "",
		Architecture: "architect",
		Research: "researcher",
		TestDesign: "test-designer",
		Implementation: "developer",
		Audit: "auditor",
		Done: "",
	},
	maxRejections: 5,
	codeowners: ["user1"],
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../worktrees",
	branchPrefix: "worktree-git-issue-",
	ciGatingTimeoutSec: 300,
	bellOnComplete: false,
	enableExperimentalFeatures: false,
	auditScoreThreshold: 0.75,
	vulnGateBlocking: false,
	vulnGateTimeoutSec: 60,
};

const ISSUE = 1830;
const BRANCH = "worktree-git-issue-1830-test";
const PUSHED_SHA = "pushedcommitsha1";

const GH_ERROR =
	"Could not look up the pull request for branch 'worktree-git-issue-1830-test': gh: authentication failed.";

const CI_BLOCKER_TITLE = "## 🔴 CI Verification Blocked — Pipeline Stopped";

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface ExecCall {
	cmd: string;
	args: string[];
}

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };

/**
 * Scripted `pi.exec`: git/gh answers are routed by command shape so the test
 * never depends on call ordering (real `pollCiChecks`, no module mocks).
 */
function createRoutedPi(
	routes: {
		pullRequest?: ExecResult;
		checkRuns?: ExecResult;
		extra?: (cmd: string, args: string[]) => ExecResult | undefined;
	},
	calls: ExecCall[] = [],
): ExtensionAPI {
	return {
		exec: (async (cmd: string, args: string[]) => {
			calls.push({ cmd, args: args ?? [] });
			const override = routes.extra?.(cmd, args);
			if (override) return override;
			if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
				return { code: 0, stdout: `${PUSHED_SHA}\n`, stderr: "" };
			}
			if (cmd === "git" && args[0] === "rev-list") {
				return { code: 0, stdout: "1\n", stderr: "" };
			}
			if (cmd === "gh" && args[0] === "api" && String(args[1] ?? "").includes("/pulls?")) {
				return (
					routes.pullRequest ?? {
						code: 0,
						stdout: JSON.stringify([{ head: { sha: PUSHED_SHA } }]),
						stderr: "",
					}
				);
			}
			if (cmd === "gh" && args[0] === "api" && args[1] === "--paginate") {
				return (
					routes.checkRuns ?? {
						code: 0,
						stdout: JSON.stringify({
							id: 1,
							name: "build",
							status: "completed",
							conclusion: "success",
						}),
						stderr: "",
					}
				);
			}
			return OK;
		}) as ExtensionAPI["exec"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
	} as ExtensionAPI;
}

function createRecordingCtx(
	cwd: string,
	notifyCalls: Array<[string, string]> = [],
): ExtensionCommandContext {
	return {
		cwd,
		ui: {
			notify: (message: string, level: string) => notifyCalls.push([message, level]),
			setStatus: () => {},
			setWidget: () => {},
		},
	} as unknown as ExtensionCommandContext;
}

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Stubs for the two heavy gates the orchestrator would otherwise run. */
const QUIET_GATES: AuditOrchestratorDeps = {
	runTscGateFn: async () => null,
	runLspPreAuditFn: async () => ({ nextStatus: "Audit", note: "lsp ok" }),
};

function resetCalls(calls: ExecCall[]): ExecCall[] {
	return calls.filter((c) => c.cmd === "git" && c.args[0] === "reset");
}

// ═══════════════════════════════════════════════════════════════════
// Phase 4 — runTscAndLspAudit: CI verdict first, blocked exits early
// ═══════════════════════════════════════════════════════════════════

describe("runTscAndLspAudit — unverifiable CI stops before the other gates (issue #1830 Phase 4)", () => {
	it("(use-case) gh error → blocked verdict, no TSC/LSP/dup work, no uncommit", async () => {
		const calls: ExecCall[] = [];
		const pi = createRoutedPi(
			{ pullRequest: { code: 1, stdout: "", stderr: "gh: authentication failed" } },
			calls,
		);
		const cwd = makeTempDir("ci-infra-cwd-");
		const wt = makeTempDir("ci-infra-wt-");
		const ctx = createRecordingCtx(cwd);

		const result = await runTscAndLspAudit(
			ISSUE,
			"ci infra blocker",
			CONFIG,
			"developer",
			{ body: "", comments: [] },
			wt,
			pi,
			ctx,
			new ErrorCollector(),
			QUIET_GATES,
		);

		assert.equal(result.outcome, "blocked");
		assert.ok(
			(result as { reason: string }).reason.includes("gh: authentication failed"),
			(result as { reason: string }).reason,
		);
		assert.deepEqual(resetCalls(calls), [], "no uncommit on the blocked path");
		assert.ok(
			!calls.some((c) => c.cmd === "git" && c.args[0] === "diff"),
			"the LSP pre-audit never runs",
		);
		assert.ok(
			!calls.some((c) => c.args.some((a) => a.includes("tsc"))),
			"no TSC invocation on the blocked path",
		);
		rmSync(cwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});

	it("(use-case) blocked verdict carries no developer-facing gate note", async () => {
		const pi = createRoutedPi({
			pullRequest: { code: 1, stdout: "", stderr: "gh: authentication failed" },
			checkRuns: { code: 0, stdout: "", stderr: "" },
		});
		const cwd = makeTempDir("ci-infra-cwd-");
		const wt = makeTempDir("ci-infra-wt-");

		const result = await runTscAndLspAudit(
			ISSUE,
			"ci infra blocker",
			CONFIG,
			"developer",
			{ body: "", comments: [] },
			wt,
			pi,
			createRecordingCtx(cwd),
			new ErrorCollector(),
			QUIET_GATES,
		);

		assert.equal(result.outcome, "blocked");
		assert.ok(!("note" in result), "no combined gate note is produced for a stopped run");
		assert.ok(!("nextStatus" in result), "no status transition is decided");
		rmSync(cwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});

	it("(use-case) failing check → Implementation and exactly one uncommit (regression)", async () => {
		const calls: ExecCall[] = [];
		const pi = createRoutedPi(
			{
				checkRuns: {
					code: 0,
					stdout: JSON.stringify({
						id: 7,
						name: "build",
						status: "completed",
						conclusion: "failure",
					}),
					stderr: "",
				},
				extra: (cmd, args) =>
					cmd === "git" && args[0] === "merge-base"
						? { code: 1, stdout: "", stderr: "" }
						: undefined,
			},
			calls,
		);
		const cwd = makeTempDir("ci-infra-cwd-");
		const wt = makeTempDir("ci-infra-wt-");

		const result = await runTscAndLspAudit(
			ISSUE,
			"ci infra blocker",
			CONFIG,
			"developer",
			{ body: "", comments: [] },
			wt,
			pi,
			createRecordingCtx(cwd),
			new ErrorCollector(),
			QUIET_GATES,
		);

		assert.equal(result.outcome, "transition");
		assert.equal((result as { nextStatus: string }).nextStatus, "Implementation");
		assert.equal(resetCalls(calls).length, 1, "the developer loop-back keeps the uncommit");
		rmSync(cwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});

	it("(use-case) passing checks → Audit (smoke regression)", async () => {
		const pi = createRoutedPi({});
		const cwd = makeTempDir("ci-infra-cwd-");
		const wt = makeTempDir("ci-infra-wt-");

		const result = await runTscAndLspAudit(
			ISSUE,
			"ci infra blocker",
			CONFIG,
			"developer",
			{ body: "", comments: [] },
			wt,
			pi,
			createRecordingCtx(cwd),
			new ErrorCollector(),
			QUIET_GATES,
		);

		assert.equal(result.outcome, "transition");
		assert.equal((result as { nextStatus: string }).nextStatus, "Audit");
		rmSync(cwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});

	it("(use-case) ciGatingTimeoutSec 0 → Audit with zero gh calls (regression)", async () => {
		const calls: ExecCall[] = [];
		const pi = createRoutedPi({}, calls);
		const cwd = makeTempDir("ci-infra-cwd-");
		const wt = makeTempDir("ci-infra-wt-");

		const result = await runTscAndLspAudit(
			ISSUE,
			"ci infra blocker",
			{ ...CONFIG, ciGatingTimeoutSec: 0 },
			"developer",
			{ body: "", comments: [] },
			wt,
			pi,
			createRecordingCtx(cwd),
			new ErrorCollector(),
			QUIET_GATES,
		);

		assert.equal(result.outcome, "transition");
		assert.equal((result as { nextStatus: string }).nextStatus, "Audit");
		assert.equal(
			calls.filter((c) => c.cmd === "gh").length,
			0,
			"a disabled gate calls gh zero times",
		);
		rmSync(cwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 5 — postPipelineBlocker: comment only, never a status change
// ═══════════════════════════════════════════════════════════════════

interface FakePortCalls {
	comments: Array<{ issueNum: number; repo: string; body: string }>;
	statuses: Array<{ itemId: string; projectId: string; fieldId: string; optionId: string }>;
}

function makeFakePort(calls: FakePortCalls, opts: { rejectComment?: string } = {}): GitHubPort {
	return {
		postIssueComment: async (issueNum: number, repo: string, body: string) => {
			calls.comments.push({ issueNum, repo, body });
			if (opts.rejectComment) throw new Error(opts.rejectComment);
		},
		setItemStatusField: async (
			itemId: string,
			projectId: string,
			fieldId: string,
			optionId: string,
		) => {
			calls.statuses.push({ itemId, projectId, fieldId, optionId });
		},
	} as unknown as GitHubPort;
}

function emptyPortCalls(): FakePortCalls {
	return { comments: [], statuses: [] };
}

describe("postPipelineBlocker — shared blocker poster (issue #1830 Phase 5)", () => {
	it("(adapter) success → exactly one postIssueComment carrying title and body", async () => {
		const calls = emptyPortCalls();
		const ctx = createRecordingCtx("/repo");

		await postPipelineBlocker(
			makeFakePort(calls),
			ctx,
			CONFIG,
			ISSUE,
			CI_BLOCKER_TITLE,
			`${GH_ERROR}\n\nThe issue is **not** Done. Its status is unchanged.`,
			new ErrorCollector(),
		);

		assert.equal(calls.comments.length, 1);
		assert.equal(calls.comments[0]!.issueNum, ISSUE);
		assert.equal(calls.comments[0]!.repo, CONFIG.repo);
		assert.ok(calls.comments[0]!.body.startsWith(CI_BLOCKER_TITLE), calls.comments[0]!.body);
		assert.ok(
			calls.comments[0]!.body.includes("gh: authentication failed"),
			calls.comments[0]!.body,
		);
	});

	it("(adapter) the CI blocker states the issue is not Done and the status is unchanged", async () => {
		const calls = emptyPortCalls();

		await postPipelineBlocker(
			makeFakePort(calls),
			createRecordingCtx("/repo"),
			CONFIG,
			ISSUE,
			CI_BLOCKER_TITLE,
			`${GH_ERROR}\n\nThe issue is **not** Done. Its status is unchanged.`,
			new ErrorCollector(),
		);

		const body = calls.comments[0]!.body;
		assert.ok(body.includes("CI Verification Blocked"), body);
		assert.match(body, /not\*\* Done|not Done/i, body);
		assert.match(body, /status is unchanged/i, body);
	});

	it("(adapter) a rejecting port resolves, warns and collects — never throws", async () => {
		const calls = emptyPortCalls();
		const notifyCalls: Array<[string, string]> = [];
		const collector = new ErrorCollector();
		const ctx = createRecordingCtx("/repo", notifyCalls);

		await postPipelineBlocker(
			makeFakePort(calls, { rejectComment: "issue is locked" }),
			ctx,
			CONFIG,
			ISSUE,
			CI_BLOCKER_TITLE,
			GH_ERROR,
			collector,
		);

		const warnings = notifyCalls.filter(([, level]) => level === "warning");
		assert.equal(warnings.length, 1, "one warning for the failed comment");
		assert.ok(warnings[0]![0].includes("issue is locked"), warnings[0]![0]);
		assert.equal(collector.all.length, 1);
		assert.equal(collector.all[0]!.severity, "warn");
		assert.ok(collector.all[0]!.message.includes("issue is locked"));
	});

	it("(adapter) the poster owns no status transition", async () => {
		const calls = emptyPortCalls();

		await postPipelineBlocker(
			makeFakePort(calls),
			createRecordingCtx("/repo"),
			CONFIG,
			ISSUE,
			CI_BLOCKER_TITLE,
			GH_ERROR,
			new ErrorCollector(),
		);

		assert.deepEqual(calls.statuses, [], "the caller decides the status");
	});

	it("(adapter) a colossal reason with markdown headings is passed through unchanged", async () => {
		const calls = emptyPortCalls();
		const reason = `## CI log\n\n${"x".repeat(20_000)}\n\n## tail`;

		await postPipelineBlocker(
			makeFakePort(calls),
			createRecordingCtx("/repo"),
			CONFIG,
			ISSUE,
			CI_BLOCKER_TITLE,
			reason,
			new ErrorCollector(),
		);

		assert.equal(calls.comments.length, 1, "a single comment");
		assert.ok(calls.comments[0]!.body.includes(reason), "the reason is not truncated or escaped");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 6 — runPreTransitionHooks: blocked, not a developer loop
// ═══════════════════════════════════════════════════════════════════

const IMPLEMENTATION_STEP = WORKFLOW.find((s) => s.status === "Implementation")!;

interface NotifyCall {
	message: string;
	level: string;
}

function buildHookRunCtx(
	opts: {
		portCalls?: PortCall[];
		notifyCalls?: NotifyCall[];
		stageState?: StageState;
	} = {},
): RunContext {
	const notifyCalls = opts.notifyCalls ?? [];
	const port =
		opts.portCalls !== undefined
			? createMockGitHubPort(
					{
						postIssueComment: async () => {},
						setItemStatusField: async () => {},
						getIssueLabels: async () => [],
						listComments: async () => [],
					},
					opts.portCalls,
				)
			: createMockGitHubPort({
					postIssueComment: async () => {},
					setItemStatusField: async () => {},
					getIssueLabels: async () => [],
					listComments: async () => [],
				});

	return {
		args: undefined,
		ctx: {
			cwd: "/repo",
			ui: {
				notify: (message: string, level: string) => notifyCalls.push({ message, level }),
				setStatus: () => {},
			},
		} as unknown as ExtensionCommandContext,
		pi: {
			exec: async () => OK,
			sendMessage: () => {},
		} as unknown as ExtensionAPI,
		issueNum: ISSUE,
		isDebug: false,
		exec: (async () => OK) as unknown as RunContext["exec"],
		notify: { info: () => {}, error: () => {} },
		collector: new ErrorCollector(),
		config: CONFIG,
		port,
		issueTitle: "ci infra blocker",
		filteredData: { body: "body", comments: [] },
		issueData: {},
		stageState: opts.stageState ?? createStageState("Implementation"),
		loopStatus: "Implementation",
		loopItem: { id: "item-1" } as ProjectItem,
		fields: [] as ProjectField[],
		statusField: { id: "status-field-id" } as ProjectField,
		projectId: "project-1",
		worktreePath: "/wt/issue-1830",
		worktreeBranch: BRANCH,
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
	} as unknown as RunContext;
}

const DATA = { body: "body", comments: [] };

describe("runPreTransitionHooks — unverifiable CI stops the loop (issue #1830 Phase 6)", () => {
	it("(use-case) blocked verdict → { kind: blocked } whose stopReason names the CI reason", async () => {
		const portCalls: PortCall[] = [];
		const runCtx = buildHookRunCtx({ portCalls });

		const outcome = await runPreTransitionHooks(
			runCtx,
			IMPLEMENTATION_STEP,
			"Audit",
			"developer",
			DATA,
			1,
			{ runAuditFn: (async () => ({ outcome: "blocked", reason: GH_ERROR })) as never },
		);

		assert.equal(outcome.kind, "blocked");
		assert.ok((outcome as { stopReason: string }).stopReason.includes("gh: authentication failed"));
		assert.ok((outcome as { stopReason: string }).stopReason.includes("CI"), "the stop names CI");
		const comments = portCalls.filter((c) => c.method === "postIssueComment");
		assert.equal(comments.length, 1, "the blocker comment is posted once");
		assert.ok(String(comments[0]!.args[2]).includes(CI_BLOCKER_TITLE));
	});

	it("(use-case) blocked path sets no gate-failure context and no developer message", async () => {
		const notifyCalls: NotifyCall[] = [];
		const stageState = createStageState("Implementation");
		const runCtx = buildHookRunCtx({ notifyCalls, stageState });
		const sendMessage = mock.fn();
		(runCtx.pi as unknown as { sendMessage: unknown }).sendMessage = sendMessage;

		await runPreTransitionHooks(runCtx, IMPLEMENTATION_STEP, "Audit", "developer", DATA, 1, {
			runAuditFn: (async () => ({ outcome: "blocked", reason: GH_ERROR })) as never,
		});

		assert.equal(stageState.gateFailureContext, undefined, "no developer feedback context");
		assert.equal(sendMessage.mock.callCount(), 0, "no 'returning to developer' message");
		assert.ok(
			!notifyCalls.some((c) => c.message.includes("Re-dispatching developer")),
			"the operator is not told the developer will be re-dispatched",
		);
	});

	it("(use-case) a throwing audit runner still proceeds (fail-open for non-CI gates)", async () => {
		const notifyCalls: NotifyCall[] = [];
		const runCtx = buildHookRunCtx({ notifyCalls });

		const outcome = await runPreTransitionHooks(
			runCtx,
			IMPLEMENTATION_STEP,
			"Audit",
			"developer",
			DATA,
			1,
			{
				runAuditFn: (async () => {
					throw new Error("TSC gate exploded");
				}) as never,
			},
		);

		assert.deepEqual(outcome, { kind: "proceed", status: "Audit" });
		assert.ok(
			notifyCalls.some((c) => c.level === "warning" && c.message.includes("TSC gate exploded")),
			"the failure is surfaced",
		);
		assert.ok(
			runCtx.collector.all.some((r) => r.message.includes("TSC gate exploded")),
			"the failure is collected",
		);
	});

	it("(use-case) CI fail → proceed to Implementation with gate context set (regression)", async () => {
		const stageState = createStageState("Implementation");
		const runCtx = buildHookRunCtx({ stageState });
		const note = "--- CI Gate (failing: build) ---\nCI checks failing: build.";

		const outcome = await runPreTransitionHooks(
			runCtx,
			IMPLEMENTATION_STEP,
			"Audit",
			"developer",
			DATA,
			2,
			{
				runAuditFn: (async () => ({
					outcome: "transition",
					nextStatus: "Implementation",
					note,
					ciFailureText: note,
				})) as never,
				postCiGateRejectionFn: (async () => 1) as never,
				upsertDeveloperPrFn: (async () => ({ success: true, source: "developer-pr" })) as never,
			},
		);

		assert.deepEqual(outcome, { kind: "proceed", status: "Implementation" });
		assert.equal(stageState.gateFailureContext, note);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 7 — operator journey: gh auth failure stops the pipeline
// ═══════════════════════════════════════════════════════════════════

const DEVELOPER_OUTPUT = "Implemented\nIMPLEMENTATION_COMPLETE";

function developerRunResult(): AgentRunResult {
	return {
		output: DEVELOPER_OUTPUT,
		success: true,
		agentName: "developer",
		toolCount: 4,
		tokenCount: 800,
		durationMs: 5_000,
		textOutput: DEVELOPER_OUTPUT,
		textOnly: "IMPLEMENTATION_COMPLETE",
		summaryLine: "Implemented the change",
		errorOutput: "",
	};
}

const JOURNEY_FIELDS: ProjectField[] = [
	{
		id: "status-field-id",
		name: "Status",
		type: "single_select",
		options: [
			{ id: "opt-backlog", name: "Backlog" },
			{ id: "opt-research", name: "Research" },
			{ id: "opt-architecture", name: "Architecture" },
			{ id: "opt-test-design", name: "TestDesign" },
			{ id: "opt-implementation", name: "Implementation" },
			{ id: "opt-audit", name: "Audit" },
			{ id: "opt-done", name: "Done" },
		],
	},
];

function makeJourneyWorktree(): string {
	const dir = mkdtempSync(join(tmpdir(), "ci-infra-journey-wt-"));
	const agentDir = join(dir, ".pi/extensions/supervisor/agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "developer.md"), "---\nname: developer\n---\n\nTest dev.", "utf-8");
	return dir;
}

function buildJourneyContext(opts: {
	pi: ExtensionAPI;
	portCalls: PortCall[];
	cwd: string;
	worktreePath: string;
	runner: ReturnType<typeof mock.fn>;
	notifyCalls?: NotifyCall[];
}): RunContext {
	const port = createMockGitHubPort(
		{
			compareBranches: async () => 3,
			listPullRequestsForBranch: async () => null,
			createPullRequest: async () => ({ number: 456 }),
			updatePullRequest: async () => {},
			postIssueComment: async () => {},
			getClosingPrsForIssue: async () => [],
			setItemStatusField: async () => {},
			getIssueLabels: async () => [],
			listComments: async () => [],
		},
		opts.portCalls,
	);
	const notifyCalls = opts.notifyCalls ?? [];

	return {
		args: undefined,
		ctx: {
			cwd: opts.cwd,
			ui: {
				notify: (message: string, level: string) => notifyCalls.push({ message, level }),
				setStatus: () => {},
				setWidget: () => {},
				confirm: async () => true,
			},
		} as unknown as ExtensionCommandContext,
		pi: opts.pi,
		issueNum: ISSUE,
		isDebug: false,
		systemPromptOptions: undefined,
		exec: (async (cmd: string) =>
			cmd === "gh"
				? {
						code: 0,
						stdout: JSON.stringify({
							number: ISSUE,
							title: "ci infra blocker",
							body: "body",
							author: { login: "user1" },
							comments: [],
						}),
						stderr: "",
					}
				: OK) as unknown as RunContext["exec"],
		notify: { info: () => {}, error: () => {} },
		collector: new ErrorCollector(),
		config: CONFIG,
		port,
		issueTitle: "ci infra blocker",
		filteredData: { body: "body", comments: [] },
		issueData: {
			number: ISSUE,
			title: "ci infra blocker",
			body: "body",
			author: { login: "user1" },
			comments: [],
		},
		stageState: createStageState("Implementation"),
		loopStatus: "Implementation",
		loopItem: { id: "item-1" } as ProjectItem,
		fields: JOURNEY_FIELDS,
		statusField: JOURNEY_FIELDS[0] as ProjectField,
		projectId: "project-1",
		worktreePath: opts.worktreePath,
		worktreeBranch: BRANCH,
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
		_runner: opts.runner,
	} as unknown as RunContext;
}

describe("operator journey — unreachable CI stops the pipeline (issue #1830 Phase 7)", () => {
	it("(user-journey) gh PR lookup fails → one blocker comment, no developer re-dispatch, no Done", async () => {
		const portCalls: PortCall[] = [];
		const execCalls: ExecCall[] = [];
		const pi = createRoutedPi(
			{ pullRequest: { code: 1, stdout: "", stderr: "gh: authentication failed" } },
			execCalls,
		);
		const runner = mock.fn(async () => developerRunResult());
		const cwd = makeTempDir("ci-infra-journey-cwd-");
		const wt = makeJourneyWorktree();

		const runCtx = buildJourneyContext({ pi, portCalls, cwd, worktreePath: wt, runner });

		await runAgentLoop(runCtx);

		assert.ok(runCtx.stopReason, "the pipeline stops");
		assert.ok(runCtx.stopReason!.includes("CI"), `the stop reason names CI: ${runCtx.stopReason}`);
		assert.ok(
			runCtx.stopReason!.includes("gh: authentication failed"),
			`the stop reason carries the gh error: ${runCtx.stopReason}`,
		);

		const comments = portCalls
			.filter((c) => c.method === "postIssueComment")
			.map((c) => c.args[2] as string);
		assert.equal(comments.length, 1, "exactly one blocker comment");
		assert.ok(comments[0]!.includes(CI_BLOCKER_TITLE), comments[0]);
		assert.ok(comments[0]!.includes("gh: authentication failed"), comments[0]);

		const devDispatches = runner.mock.calls.filter((c) => {
			const args = c.arguments as unknown as Array<{ agent?: { config?: { name?: string } } }>;
			return args[0]?.agent?.config?.name === "developer";
		});
		assert.equal(devDispatches.length, 1, "the developer is not re-dispatched (AC1)");

		rmSync(cwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});

	it("(user-journey) no Audit/Done transition and the loop status stays Implementation (AC1)", async () => {
		const portCalls: PortCall[] = [];
		const pi = createRoutedPi({
			pullRequest: { code: 1, stdout: "", stderr: "gh: authentication failed" },
		});
		const runner = mock.fn(async () => developerRunResult());
		const cwd = makeTempDir("ci-infra-journey-cwd-");
		const wt = makeJourneyWorktree();

		const runCtx = buildJourneyContext({ pi, portCalls, cwd, worktreePath: wt, runner });

		await runAgentLoop(runCtx);

		const transitions = portCalls
			.filter((c) => c.method === "setItemStatusField")
			.map((c) => c.args[3] as string);
		assert.ok(!transitions.includes("opt-audit"), "no Audit transition");
		assert.ok(!transitions.includes("opt-done"), "no Done transition");
		assert.equal(runCtx.loopStatus, "Implementation", "the issue is never reported Done");

		rmSync(cwd, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	});

	it("(user-journey) pending-at-timeout blocker lists the pending checks and states not-Done (AC2/AC3)", async () => {
		const portCalls: PortCall[] = [];
		// Composed without real timers: the gate's pending verdict feeds the poster.
		const runCtx = buildHookRunCtx({ portCalls });

		const outcome = await runPreTransitionHooks(
			runCtx,
			IMPLEMENTATION_STEP,
			"Audit",
			"developer",
			DATA,
			1,
			{
				runAuditFn: (async () => ({
					outcome: "blocked",
					reason: "CI checks still pending after 300s timeout: build, e2e.",
				})) as never,
			},
		);

		assert.equal(outcome.kind, "blocked");
		const comments = portCalls
			.filter((c) => c.method === "postIssueComment")
			.map((c) => c.args[2] as string);
		assert.equal(comments.length, 1);
		assert.ok(comments[0]!.includes("build"), comments[0]);
		assert.ok(comments[0]!.includes("e2e"), comments[0]);
		assert.match(comments[0]!, /status is unchanged/i);
		const stopReason = (outcome as { stopReason: string }).stopReason;
		assert.ok(stopReason.includes("build"), stopReason);
		assert.ok(stopReason.includes("e2e"), stopReason);
	});
});
