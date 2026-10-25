import { describe, it, beforeEach } from "node:test";

import assert from "node:assert/strict";

import { readFileSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from "node:fs";

import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { SupervisorConfig, AgentRunResult, FilteredIssueData } from "../config/types.ts";

import { ErrorCollector } from "../pipeline/error-collector.ts";

import { handlePostAgentSuccess } from "../pipeline/stages/index.ts";

import { createMockGitHubPort } from "./helper/mock-github-port.ts";

import type { GitHubPort } from "../github/ports.ts";

import {
	CapturedOutput,
	createMockPi,
	createMockCtx,
	resetMocks,
	setMockResponses,
	makeExecResult,
} from "./helpers/capture.ts";

function createMockPortForTest(pi: ExtensionAPI): GitHubPort {
	return createMockGitHubPort({
		postIssueComment: async (issueNum: number, repo: string, body: string) => {
			const tempDir = "ignore";
			const tempFile = join(tempDir, `comment-body-${issueNum}-${Date.now()}.md`);
			mkdirSync(tempDir, { recursive: true });
			writeFileSync(tempFile, body, "utf8");
			await pi.exec("gh", [
				"issue",
				"comment",
				String(issueNum),
				"--body-file",
				tempFile,
				"--repo",
				repo,
			]);
			unlinkSync(tempFile);
		},
	});
}

function createBodyCapturePi(captured: CapturedOutput, capturedBodies: string[]): ExtensionAPI {
	const pi = createMockPi(captured);
	const origExec = pi.exec;
	pi.exec = (async (cmd: string, args: string[] = [], opts?: Record<string, unknown>) => {
		// Intercept gh/bash calls that carry --body-file to capture body content
		if (args.includes("--body-file")) {
			const bodyFileIdx = args.indexOf("--body-file");
			const bodyPath = args[bodyFileIdx + 1];
			if (bodyPath) {
				try {
					const body = readFileSync(bodyPath, "utf-8");
					capturedBodies.push(body);
				} catch {
					capturedBodies.push("");
				}
			}
		}
		return origExec(cmd, args, opts);
	}) as ExtensionAPI["exec"];
	return pi;
}

const mockConfig: SupervisorConfig = {
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
	maxRejections: 3,
	codeowners: ["testuser"],
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

const filteredData: FilteredIssueData = { body: "", comments: [] };

function makeResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
	return {
		output: "",
		success: true,
		agentName: "researcher",
		toolCount: 5,
		tokenCount: 2000,
		durationMs: 10000,
		textOutput: "",
		summaryLine: "Completed",
		errorOutput: "",
		textOnly: "",
		...overrides,
	};
}

function registerGhResponse(): void {
	setMockResponses({
		"gh issue comment *": makeExecResult({ code: 0 }),
		"bash -c *": makeExecResult({ code: 0, stdout: "" }),
	});
}

describe("handlePostAgentSuccess — comment posting", () => {
	let captured: CapturedOutput;
	let capturedBodies: string[];
	beforeEach(() => {
		captured = new CapturedOutput();
		capturedBodies = [];
		resetMocks();
		// Ensure ignore/ directory exists for postIssueComment temp files
		if (!existsSync("ignore")) {
			mkdirSync("ignore", { recursive: true });
		}
	});
	it("Test-designer heading already present → no injection, no heading warn", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "test-designer",
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "test-designer",
				commentBody: "## Test Plan\n- Test case 1\n- Test case 2",
				summary: "Test design complete",
			}),
		});

		const port = createMockPortForTest(pi);
		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"test-designer",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
			collector,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "pipeline should continue");

		// Comment posted normally
		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call");

		assert.equal(capturedBodies.length, 1, "one comment body captured");
		const body = capturedBodies[0] || "";
		assert.ok(body.includes("## Test Plan"), "body contains ## Test Plan heading");
		assert.ok(body.includes("Test case 1"), "body preserves original content");

		// No heading-related warn
		const headingWarns = collector.flush("stages").filter((w) => w.message.includes("heading"));
		assert.equal(headingWarns.length, 0, "no heading-related warn messages");

		// Info notification for posted comment
		const infoNotifications = captured.notifications.filter((n) => n.type === "info");
		assert.ok(
			infoNotifications.some((n) => n.msg.includes("Posted test-designer comment")),
			"info notification for posted comment",
		);
	});
	it("Researcher heading already present → no skip, no heading warn", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "researcher",
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "researcher",
				commentBody: "## Research Findings\n- Finding 1\n- Finding 2",
				summary: "Research complete",
			}),
		});

		const port = createMockPortForTest(pi);
		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"researcher",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
			collector,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "pipeline should continue");

		// Comment posted normally
		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call");

		assert.equal(capturedBodies.length, 1, "one comment body captured");
		const body = capturedBodies[0] || "";
		assert.ok(body.includes("## Research Findings"), "body contains ## Research Findings heading");
		assert.ok(body.includes("Finding 1"), "body preserves original content");

		// No heading-related warn
		const headingWarns = collector.flush("stages").filter((w) => w.message.includes("heading"));
		assert.equal(headingWarns.length, 0, "no heading-related warn messages");

		// Info notification for posted comment
		const infoNotifications = captured.notifications.filter((n) => n.type === "info");
		assert.ok(
			infoNotifications.some((n) => n.msg.includes("Posted researcher comment")),
			"info notification for posted comment",
		);
	});
	it("commentBody null with test-designer → no heading validation, no heading warn", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		// No output at all → commentBody stays null → heading checks don't fire
		const result = makeResult({
			agentName: "test-designer",
			textOutput: "",
			textOnly: "",
			thinkingOutput: undefined,
		});
		// Ensure bare-text fallback also yields nothing — no matching keywords
		result.output = "irrelevant content";

		const port = createMockPortForTest(pi);
		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"test-designer",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
			collector,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "pipeline should continue");

		// No gh call (no comment to post)
		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 0, "no gh issue comment call (commentBody null)");

		// No heading-related warn
		const warns = collector.flush("stages");
		const headingWarns = warns.filter((w) => w.message.includes("heading"));
		assert.equal(headingWarns.length, 0, "no heading-related warn messages");

		// There IS a general "no commentBody found" warn
		assert.ok(
			warns.some((w) => w.message.includes("no commentBody found")),
			"generic warn about missing commentBody",
		);
	});
	it("agentName not covered by heading rules (developer) → no heading validation code runs", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
		});

		// Register git responses for commitAndPush
		setMockResponses({
			"git add -A": makeExecResult({ code: 0 }),
			"git diff --cached --quiet": makeExecResult({ code: 1 }),
			"git commit -m feat(#42): Test issue": makeExecResult({ code: 0, stdout: "committed" }),
			"git push origin feature-branch": makeExecResult({ code: 0 }),
		});

		const port = createMockPortForTest(pi);
		// Developer goes through commit+push path, not comment-posting path —
		// heading validation is entirely skipped
		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
			collector,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "commitAndPush succeeded — pipeline continues");

		// No heading-related warns (heading code never ran)
		const warns = collector.flush("stages");
		const headingWarns = warns.filter((w) => w.message.includes("heading"));
		assert.equal(headingWarns.length, 0, "no heading-related warn messages");

		// Git calls happen (commit+push path)
		const gitCalls = captured.execCalls.filter((c) => c.cmd === "git");
		assert.ok(gitCalls.length >= 3, "git operations executed");
	});
});
