// ─── Tests: Tier-Large operator journey (issue #1987) ─────────────
// End-to-end: a Large-tier test plan raises the developer deadline to 60
// minutes; on a simulated deadline kill the operator sees a run result
// naming tier/base/effective/actual plus the preserved WIP sha, partial
// output causes no status transition, and the next developer task
// instructs resume instead of restart.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRunResult, SupervisorConfig } from "../../config/types.ts";
import type { RunContext } from "../../pipeline/handler/shared.ts";
import type { PortCall } from "../helper/mock-github-port.ts";
import { createMockGitHubPort } from "../helper/mock-github-port.ts";
import { runAgentLoop } from "../../pipeline/handler/agent-loop.ts";
import { runPostPipelinePhase } from "../../pipeline/handler/post-pipeline.ts";
import { cleanupOnExit, shouldRetainWorktree } from "../../pipeline/crash-cleanup.ts";
import { buildPipelineSummary } from "../../pipeline/output.ts";
import { createStageState } from "../../pipeline/stages/index.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import { loadConfig, resolveTimeoutPolicy } from "../../config/config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../../..");
const WIP_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const LARGE_TEST_PLAN = "## Test Plan\n**Tier:** Large";

const mockConfig: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {
		Backlog: "",
		Research: "researcher",
		Architecture: "architect",
		TestDesign: "test-designer",
		Implementation: "developer",
		Audit: "auditor",
		Done: "",
	},
	maxRejections: 3,
	codeowners: ["user1"],
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../worktrees/",
	branchPrefix: "worktree-git-issue-",
	ciGatingTimeoutSec: 0,
	bellOnComplete: false,
	enableExperimentalFeatures: false,
	auditScoreThreshold: 0.75,
	vulnGateBlocking: false,
	vulnGateTimeoutSec: 60,
	agentTimeoutsMin: {},
	agentTimeoutTierScale: { medium: 1.5, large: 2 },
};

/** Answers the preserve-path argv sequence (status/add/diff/commit/push/rev-parse). */
function journeyGit(args: string[]): { code: number; stdout?: string; stderr?: string } | null {
	switch (args[0]) {
		case "log":
			return { code: 0, stdout: `${WIP_SHA} wip(#1987): partial work preserved on timeout\n` };
		case "status":
			return { code: 0, stdout: " M src/a.ts\n" };
		case "add":
			return { code: 0 };
		case "diff":
			return { code: 1, stdout: "src/a.ts\n" };
		case "commit":
			return { code: 0 };
		case "push":
			return { code: 0 };
		case "rev-parse":
			return { code: 0, stdout: `${WIP_SHA}\n` };
		default:
			return null;
	}
}

function buildJourneyContext(opts: {
	runner: ReturnType<typeof import("node:test").mock.fn>;
	portCalls: PortCall[];
	comments: Array<{ author: { login: string }; body: string }>;
	wt: string;
	onGit?: (args: string[]) => void;
	pushFails?: boolean;
	stallPush?: () => Promise<void>;
}): RunContext {
	const pi = {
		exec: async (cmd: string, args: string[]) => {
			opts.onGit?.(args || []);
			if (opts.pushFails && args?.[0] === "push") {
				return { code: 1, stdout: "", stderr: "push rejected" };
			}
			if (opts.stallPush && args?.[0] === "push") {
				await opts.stallPush();
				return { code: 0, stdout: "", stderr: "" };
			}
			const r = journeyGit(args || []);
			return { code: r?.code ?? 0, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
		},
		sendMessage: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: opts.wt,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			confirm: async () => true,
			theme: { fg: (_color: string, s: string) => s },
		},
	} as unknown as ExtensionCommandContext;
	const port = createMockGitHubPort(
		{
			getClosingPrsForIssue: async () => [],
			postIssueComment: async () => {},
			closeIssue: async () => {},
			setItemStatusField: async () => {},
		},
		opts.portCalls,
	);
	return {
		args: undefined,
		ctx,
		pi,
		issueNum: 1987,
		isDebug: false,
		systemPromptOptions: undefined,
		exec: (async (cmd: string) => {
			if (cmd === "gh") {
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 1987,
						title: "Large issue",
						body: "body",
						author: { login: "user1" },
						comments: opts.comments,
					}),
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		}) as unknown as RunContext["exec"],
		notify: { info: () => {}, error: () => {} },
		collector: new ErrorCollector(),
		config: mockConfig,
		port,
		issueTitle: "Large issue",
		filteredData: { body: "body", comments: [] },
		issueData: { number: 1987, title: "Large issue", body: "body", author: { login: "user1" }, comments: [] },
		stageState: createStageState("Implementation"),
		loopStatus: "Implementation",
		loopItem: { id: "item-1" },
		fields: [
			{
				id: "status-field-id",
				name: "Status",
				type: "single_select",
				options: [
					{ id: "opt-implementation", name: "Implementation" },
					{ id: "opt-audit", name: "Audit" },
				],
			},
		] as any,
		statusField: { id: "status-field-id", name: "Status" } as any,
		projectId: "project-1",
		worktreePath: opts.wt,
		worktreeBranch: "worktree-git-issue-1987-test",
		prCreationResult: undefined,
		crashCleanup: undefined,
		stopReason: undefined,
		agentResults: [],
		_runner: opts.runner,
	} as unknown as RunContext;
}

function timedOutDeveloper(): AgentRunResult {
	return {
		output: "raw",
		success: false,
		agentName: "developer",
		toolCount: 5,
		tokenCount: 1000,
		durationMs: 3_600_123,
		textOutput: "partial\nIMPLEMENTATION_COMPLETE",
		textOnly: "IMPLEMENTATION_COMPLETE",
		summaryLine: "Timed out",
		errorOutput: "[Timeout: developer exceeded 3600s]",
		timedOut: true,
		killReason: "timeout",
		configuredTimeoutMs: 3_600_000,
	};
}

describe("operator journey — Tier-Large deadline + preservation (issue #1987)", () => {
	it("real .pi/settings.json enables tier scaling and keeps agentTimeoutSec unscaled", () => {
		const raw = JSON.parse(readFileSync(join(REPO_ROOT, ".pi/settings.json"), "utf-8")).supervisor;
		assert.deepEqual(raw.agentTimeoutTierScale, { medium: 1.5, large: 2 });
		assert.ok(!raw.agentTimeoutSec || Object.keys(raw.agentTimeoutSec).length === 0);

		const cfg = loadConfig();
		assert.equal(resolveTimeoutPolicy("developer", cfg, "large").timeoutMs, 3_600_000);
	});

	it("docs document agentTimeoutTierScale and the unscaled agentTimeoutSec override", () => {
		const supervisorDoc = readFileSync(join(REPO_ROOT, "docs/extensions/supervisor.md"), "utf-8");
		assert.ok(supervisorDoc.includes("agentTimeoutTierScale"), "supervisor.md field row");
		assert.match(supervisorDoc, /agentTimeoutSec[^\n]*unscaled/i, "agentTimeoutSec documented as unscaled");
		const githubDoc = readFileSync(join(REPO_ROOT, "docs/github.md"), "utf-8");
		assert.ok(githubDoc.includes("agentTimeoutTierScale"), "github.md field row");
	});

	it("Large-tier timeout names tier/base/effective/actual + preserved sha; no transition", async () => {
		const portCalls: PortCall[] = [];
		const runner = async () => timedOutDeveloper();
		const wt = mkdtempSync(join(tmpdir(), "journey-wt-"));
		const runCtx = buildJourneyContext({
			runner: runner as any,
			portCalls,
			comments: [{ author: { login: "user1" }, body: LARGE_TEST_PLAN }],
			wt,
		});

		await runAgentLoop(runCtx);

		const stop = runCtx.stopReason ?? "";
		assert.ok(stop.includes("tier large"), stop);
		assert.ok(stop.includes("base 1800000ms"), stop);
		assert.ok(stop.includes("effective 3600000ms"), stop);
		assert.ok(stop.includes("actual 3600123ms"), stop);
		assert.ok(stop.includes("preserved 1 file(s)"), stop);
		assert.ok(stop.includes(WIP_SHA), stop);
		assert.equal(
			portCalls.filter((c) => c.method === "setItemStatusField").length,
			0,
			"partial output causes no status transition",
		);

		// The operator-visible pipeline summary must carry the same detail: a
		// timed-out agent is recorded FAILED, so without surfacing stopReason the
		// summary would collapse to the generic "agent failed" line (audit fix).
		const summary = buildPipelineSummary(
			runCtx.agentResults,
			"failed",
			1987,
			"Large issue",
			mockConfig,
			runCtx.stopReason,
		);
		assert.ok(summary.includes("tier large"), "summary names the tier");
		assert.ok(summary.includes("effective 3600000ms"), "summary names the effective timeout");
		assert.ok(summary.includes("preserved 1 file(s)"), "summary names the preserved work");
		assert.ok(summary.includes(WIP_SHA), "summary names the preserved sha");
		assert.ok(!summary.includes("— agent failed"), "summary does not collapse to agent failed");
	});

	it("the next developer task instructs resume via the preserved WIP commit", async () => {
		const portCalls: PortCall[] = [];
		let capturedTask = "";
		const runner = async (opts: any) => {
			capturedTask = opts.task;
			return timedOutDeveloper();
		};
		const wt = mkdtempSync(join(tmpdir(), "journey-resume-wt-"));
		const runCtx = buildJourneyContext({
			runner: runner as any,
			portCalls,
			comments: [{ author: { login: "user1" }, body: LARGE_TEST_PLAN }],
			wt,
		});

		await runAgentLoop(runCtx);

		assert.ok(capturedTask.includes("continue, do not restart"), "resume instruction present");
		assert.ok(capturedTask.includes(WIP_SHA), "resume instruction names the WIP sha");
	});

	it("preservation push failure keeps the worktree + branch through post-pipeline cleanup", async () => {
		// Audit finding: when `git push` is rejected, preservation fails and the
		// worktree/branch may hold the ONLY copy of the developer's work. Cleanup
		// must not remove them just because the run ended.
		const portCalls: PortCall[] = [];
		const gitCalls: string[][] = [];
		const runner = async () => timedOutDeveloper();
		const wt = mkdtempSync(join(tmpdir(), "journey-preserve-fail-wt-"));
		const runCtx = buildJourneyContext({
			runner: runner as any,
			portCalls,
			comments: [{ author: { login: "user1" }, body: LARGE_TEST_PLAN }],
			wt,
			onGit: (args) => gitCalls.push(args),
			pushFails: true,
		});

		await runAgentLoop(runCtx);
		assert.equal(runCtx.preservationFailed, true, "push failure marks preservation failed");
		assert.ok(
			(runCtx.stopReason ?? "").includes("work preservation failed"),
			runCtx.stopReason,
		);

		await runPostPipelinePhase(runCtx);

		const commands = gitCalls.map((a) => a[0]);
		assert.ok(!commands.includes("worktree"), "cleanupWorktree must not run");
		assert.ok(!commands.includes("branch"), "branch -D must not run");
	});

	it("stalled preservation push + shutdown retains the worktree (issue #1987)", async () => {
		// Audit finding: an unbounded push can stall until SIGTERM, before
		// `preservationFailed` is set, so crash cleanup would delete the
		// worktree/branch holding the only copy of the work. The in-flight flag
		// must keep them; the push itself is bounded.
		const portCalls: PortCall[] = [];
		const runner = async () => timedOutDeveloper();
		const wt = mkdtempSync(join(tmpdir(), "journey-stall-wt-"));
		let releasePush: () => void = () => {};
		const pushGate = new Promise<void>((res) => {
			releasePush = res;
		});
		const runCtx = buildJourneyContext({
			runner: runner as any,
			portCalls,
			comments: [{ author: { login: "user1" }, body: LARGE_TEST_PLAN }],
			wt,
			stallPush: () => pushGate,
		});

		const loop = runAgentLoop(runCtx);
		for (let i = 0; i < 500 && runCtx.preservationInProgress !== true; i++) {
			await new Promise((r) => setTimeout(r, 1));
		}
		assert.equal(runCtx.preservationInProgress, true, "preservation in flight");

		const cleanupCalls: string[][] = [];
		await cleanupOnExit("SIGTERM", {
			worktreePath: runCtx.worktreePath,
			worktreeBranch: runCtx.worktreeBranch,
			pi: {
				exec: async (_cmd: string, args: string[]) => {
					cleanupCalls.push(args);
					return { code: 0, stdout: "", stderr: "" };
				},
			} as unknown as ExtensionAPI,
			cwd: wt,
			notify: { info: () => {}, error: () => {} },
			debugLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
			shouldSkip: () => shouldRetainWorktree(runCtx),
			exit: () => {},
		});
		assert.equal(cleanupCalls.length, 0, "worktree + branch retained during in-flight preservation");

		releasePush();
		await loop;
	});
});
