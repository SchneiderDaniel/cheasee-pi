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
	it("Researcher posts findings: textOutput with complete JSON → gh issue comment posted", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const result = makeResult({
			agentName: "researcher",
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "researcher",
				commentBody: "## Research Findings\n- Finding 1\n- Finding 2\n- Finding 3",
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
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "pipeline should continue");

		// Exactly one gh issue comment call
		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "exactly one gh issue comment call");
		assert.ok(ghCalls[0].args.includes("42"), "gh call references issue number 42");

		// Body captured from --body-file
		assert.equal(capturedBodies.length, 1, "one comment body captured");
		assert.ok(
			capturedBodies[0].includes("## Research Findings"),
			"body contains ## Research Findings heading",
		);
		assert.ok(capturedBodies[0].includes("Finding 1"), "body contains research content");

		// Notification
		const infoNotifications = captured.notifications.filter((n) => n.type === "info");
		assert.ok(
			infoNotifications.some((n) => n.msg.includes("Posted researcher comment")),
			"info notification for posted comment",
		);
	});
	it("Researcher graceful degradation: empty textOutput → fallback comment posted", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const result = makeResult({
			agentName: "researcher",
			textOutput: "",
			output: "",
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
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "pipeline should continue");

		// Fallback comment posted
		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call for fallback");
		assert.equal(capturedBodies.length, 1, "one comment body captured");
		assert.ok(
			capturedBodies[0].includes("No relevant results found"),
			"fallback body contains 'No relevant results found'",
		);

		// Notification
		const infoNotifications = captured.notifications.filter((n) => n.type === "info");
		assert.ok(
			infoNotifications.some((n) => n.msg.includes("graceful degradation")),
			"info notification for graceful degradation comment",
		);
	});
	it("Researcher budget exceeded: budgetExceeded=true → single combined comment with stopped-early header", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const result = makeResult({
			agentName: "researcher",
			tokenCount: 50000,
			budgetExceeded: true,
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "researcher",
				commentBody: "## Research Findings\n- Finding 1\n- Partial finding 2",
				summary: "Research complete (budget exceeded)",
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
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "pipeline should continue");

		// Single combined comment (NOT two separate calls)
		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "exactly one gh issue comment call (combined message)");

		// Body contains stopped-early header
		assert.equal(capturedBodies.length, 1, "one comment body captured");
		const body = capturedBodies[0] || "";
		assert.ok(
			body.includes("Research stopped early"),
			"body contains 'Research stopped early' header",
		);
		assert.ok(body.includes("50000"), "body contains tokenCount value");
		assert.ok(body.includes("Finding 1"), "body contains partial findings content");

		// Notification (single)
		const infoNotifications = captured.notifications.filter((n) => n.type === "info");
		assert.ok(
			infoNotifications.some((n) => n.msg.includes("Posted researcher comment")),
			"info notification for posted comment",
		);
	});
	it("Architect posts architecture: textOutput with ## Architecture → comment posted", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const result = makeResult({
			agentName: "architect",
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "architect",
				commentBody: "## Architecture\n- Component diagram\n- Data flow",
				summary: "Architecture defined",
			}),
		});

		const port = createMockPortForTest(pi);
		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"architect",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "pipeline should continue");

		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "exactly one gh issue comment call");

		assert.equal(capturedBodies.length, 1, "one comment body captured");
		assert.ok(
			capturedBodies[0].includes("## Architecture"),
			"body contains ## Architecture heading",
		);

		const infoNotifications = captured.notifications.filter((n) => n.type === "info");
		assert.ok(
			infoNotifications.some((n) => n.msg.includes("Posted architect comment")),
			"info notification for posted comment",
		);
	});
	it("Architect missing ## Architecture heading → heading injected, comment posted with warning", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "architect",
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "architect",
				commentBody: "## Design Notes\nSome design notes without the required heading",
				summary: "Architecture defined",
			}),
		});

		const port = createMockPortForTest(pi);
		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"architect",
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

		// Exactly one gh call (heading is injected, comment IS posted)
		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call (heading injected)");

		// Body contains injected ## Architecture heading
		assert.equal(capturedBodies.length, 1, "one comment body captured");
		const body = capturedBodies[0] || "";
		assert.ok(body.includes("## Architecture"), "body contains injected ## Architecture heading");
		assert.ok(body.includes("Design Notes"), "body preserves original content");

		// Collector has warn about missing heading
		const warns = collector.flush("stages");
		assert.ok(
			warns.some((w) => w.message.includes('"## Architecture"')),
			"warn message mentions missing ## Architecture heading",
		);

		// Info notification for posted comment
		const infoNotifications = captured.notifications.filter((n) => n.type === "info");
		assert.ok(
			infoNotifications.some((n) => n.msg.includes("Posted architect comment")),
			"info notification for posted comment",
		);
	});
	it("Test-designer missing ## Test Plan heading → heading injected, comment posted with warning", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "test-designer",
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "test-designer",
				commentBody: "## Test Strategy\nSome test approach without Test Plan heading",
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

		// Exactly one gh call (heading is injected, comment IS posted)
		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call (heading injected)");

		// Body contains injected ## Test Plan heading
		assert.equal(capturedBodies.length, 1, "one comment body captured");
		const body = capturedBodies[0] || "";
		assert.ok(body.includes("## Test Plan"), "body contains injected ## Test Plan heading");
		assert.ok(body.includes("Test Strategy"), "body preserves original content");

		// Collector has warn about missing heading
		const warns = collector.flush("stages");
		assert.ok(
			warns.some((w) => w.message.includes('"## Test Plan"')),
			"warn message mentions missing ## Test Plan heading",
		);

		// Info notification for posted comment
		const infoNotifications = captured.notifications.filter((n) => n.type === "info");
		assert.ok(
			infoNotifications.some((n) => n.msg.includes("Posted test-designer comment")),
			"info notification for posted comment",
		);
	});
});
