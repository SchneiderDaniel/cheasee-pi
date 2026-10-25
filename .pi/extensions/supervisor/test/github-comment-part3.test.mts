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
	it("Extraction bare-text fallback: test-designer wraps in ## Test Plan heading", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "test-designer",
			textOnly: "",
			textOutput: "Test Plan:\n- Scenario A\n- Scenario B",
			thinkingOutput: undefined,
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

		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call via bare-text fallback");

		assert.equal(capturedBodies.length, 1, "one comment body captured");
		const body = capturedBodies[0] || "";
		assert.ok(body.includes("## Test Plan"), "body has injected ## Test Plan heading");
		assert.ok(body.includes("- Scenario A"), "body preserves original content");

		const warns = collector.flush("stages");
		assert.ok(
			warns.some((w) => w.message.includes("bare text fallback")),
			"collector receives warn about bare text fallback",
		);
	});
	it("Extraction bare-text fallback: researcher wraps in ## Research Findings heading", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "researcher",
			textOnly: "",
			textOutput: "Research indicates that the system performs well under load.",
			thinkingOutput: undefined,
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

		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call via bare-text fallback");

		assert.equal(capturedBodies.length, 1, "one comment body captured");
		const body = capturedBodies[0] || "";
		assert.ok(
			body.includes("## Research Findings"),
			"body has injected ## Research Findings heading",
		);
		assert.ok(body.includes("Research indicates"), "body preserves original content");

		const warns = collector.flush("stages");
		assert.ok(
			warns.some((w) => w.message.includes("bare text fallback")),
			"collector receives warn about bare text fallback",
		);
	});
	it("Architect bare-text fallback ignores result.output (protocol leak guard, issue #1671)", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		// Simulates the 400-API-error empty run from issue #1671: no text, zero
		// tokens/tools, but raw subprocess stdout (pi NDJSON protocol echoing
		// the task prompt) containing the role keyword "Architecture".
		const result = makeResult({
			agentName: "architect",
			textOnly: "",
			textOutput: "",
			thinkingOutput: undefined,
			output:
				'{"type":"session","version":3,"cwd":"/worktree"}\n{"type":"message_start","message":{"content":[{"type":"text","text":"Architecture design for ticket..."}]}}',
			tokenCount: 0,
			toolCount: 0,
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

		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(
			ghCalls.length,
			0,
			"no comment posted — raw protocol output must never reach GitHub",
		);
		assert.equal(capturedBodies.length, 0, "no comment body captured");

		const warns = collector.flush("stages");
		assert.ok(
			warns.some((w) => w.message.includes("produced no output")),
			"collector receives warn about the empty run",
		);
	});
	it("Researcher empty run with raw output → graceful degradation comment, not protocol dump (issue #1671)", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "researcher",
			textOnly: "",
			textOutput: "",
			thinkingOutput: undefined,
			output:
				'{"type":"session","version":3,"cwd":"/worktree"}\n{"type":"message_start","message":{"content":[{"type":"text","text":"Research indicates the system is fine"}]}}',
			tokenCount: 0,
			toolCount: 0,
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

		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call — graceful degradation only");

		assert.equal(capturedBodies.length, 1, "one comment body captured");
		const body = capturedBodies[0] || "";
		assert.ok(
			body.includes("No relevant results found"),
			"body contains graceful degradation message",
		);
		assert.ok(!body.includes('{"type":"session"'), "raw protocol NDJSON NOT posted to GitHub");
		assert.ok(
			!body.includes("Research indicates"),
			"protocol-echoed task text NOT posted to GitHub",
		);

		const warns = collector.flush("stages");
		assert.ok(
			warns.some(
				(w) =>
					w.message.includes("produced no output") ||
					w.message.includes("no commentBody in JSON output"),
			),
			"collector receives warn about the empty run",
		);
	});
	it("Researcher missing ## Research Findings heading → heading check nullifies commentBody, graceful degradation fallback posted", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "researcher",
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "researcher",
				commentBody: "# Research Notes\nSome findings without the required heading",
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

		// A gh call fires — but for the graceful degradation fallback, not the original content
		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call (graceful degradation fallback)");

		assert.equal(capturedBodies.length, 1, "one comment body captured");
		const body = capturedBodies[0] || "";
		// Body is the graceful degradation fallback, NOT the original content
		assert.ok(
			body.includes("No relevant results found"),
			"body contains graceful degradation message",
		);
		// Original content was nullified by heading check — NOT posted
		assert.ok(!body.includes("Research Notes"), "original missing-heading content NOT posted");

		// Collector has warn about missing heading with Skipping post
		const warns = collector.flush("stages");
		assert.ok(
			warns.some((w) => w.message.includes("Skipping post")),
			"warn message says Skipping post",
		);
		assert.ok(
			warns.some((w) => w.message.includes("Research Findings")),
			"warn message mentions ## Research Findings heading",
		);
	});
	it("Architect heading already present → no injection, no heading warn", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
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
		assert.ok(body.includes("## Architecture"), "body contains ## Architecture heading");
		assert.ok(body.includes("Component diagram"), "body preserves original content");

		// No heading-related warn
		const headingWarns = collector.flush("stages").filter((w) => w.message.includes("heading"));
		assert.equal(headingWarns.length, 0, "no heading-related warn messages");

		// Info notification for posted comment
		const infoNotifications = captured.notifications.filter((n) => n.type === "info");
		assert.ok(
			infoNotifications.some((n) => n.msg.includes("Posted architect comment")),
			"info notification for posted comment",
		);
	});
});
