/**
 * github-comment.test.mts — Tests for handlePostAgentSuccess() comment posting logic.
 *
 * Uses the shared capture harness from helpers/capture.ts (issue 2).
 * Covers all 4 agent types (researcher, architect, test-designer, developer) with
 * 10 test scenarios: comment posting, heading validation, graceful degradation,
 * budget-exceeded handling, trailing code fence stripping, extraction fallback,
 * and commit+push.
 *
 * Body capture reads the comment body from the --body-file temp file before
 * postIssueComment deletes it (same pattern as stages.test.mts:1937).
 *
 * Run with: node --experimental-strip-types --test
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, AgentRunResult, FilteredIssueData } from "../config/types.ts";
import { ErrorCollector } from "../pipeline/error-collector.ts";
import { handlePostAgentSuccess } from "../pipeline/stages.ts";
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

// ═══════════════════════════════════════════════════════════════════════
// Body-capture shim
// ═══════════════════════════════════════════════════════════════════════
//
// postIssueComment writes body to ignore/comment-body-<issueNum>-<ts>.md,
// calls gh --body-file <path>, then deletes the file in its finally block.
// This shim intercepts the gh exec call, reads the body file before deletion,
// and captures the content into an array for test assertions.

/**
 * Create a mock port whose postIssueComment delegates to pi.exec for gh calls,
 * allowing the body-capture shim to intercept and record bodies.
 */
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

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/** Register gh response so postIssueComment succeeds through the mock */
function registerGhResponse(): void {
	setMockResponses({
		"gh issue comment *": makeExecResult({ code: 0 }),
		"bash -c *": makeExecResult({ code: 0, stdout: "" }),
	});
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

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

	// ── Phase 1: Researcher comment posting ───────────────────────

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

	// ── Phase 2: Architect comment posting — heading validation ───

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

	// ── Phase 3: Test-designer comment posting — heading validation ──

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

	// ── Phase 4: Developer commit+push ─────────────────────────────

	it("Developer commit+push: worktreePath + worktreeBranch set → git commands executed, returns true", async () => {
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const result = makeResult({
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
		});

		// Register git responses for commitAndPush
		setMockResponses({
			"git add -A": makeExecResult({ code: 0 }),
			"git diff --cached --quiet": makeExecResult({ code: 1 }), // changes staged
			"git commit -m feat(#42): Test issue": makeExecResult({ code: 0, stdout: "committed" }),
			"git push origin feature-branch": makeExecResult({ code: 0 }),
			// checkReadmeUpdated git diff will fall through to default code:1 — fine
		});

		const port = createMockPortForTest(pi);
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
			undefined,
			undefined,
			undefined,
			port,
		);

		assert.equal(success, true, "commitAndPush succeeded — pipeline continues");

		// Git calls: at minimum add + commit + push (plus diff --cached and checkReadmeUpdated)
		const gitCalls = captured.execCalls.filter((c) => c.cmd === "git");
		assert.ok(gitCalls.length >= 3, "should have git operations");

		const addCall = gitCalls.find((c) => c.args[0] === "add");
		assert.ok(addCall, "git add called");

		const commitCalls = gitCalls.filter((c) => c.args[0] === "commit" && c.args[1] === "-m");
		assert.ok(commitCalls.length >= 1, "git commit called");
		assert.ok(
			commitCalls.some((c) => c.args[2] === "feat(#42): Test issue"),
			"commit message matches feat(#42): Test issue",
		);

		const pushCall = gitCalls.find((c) => c.args[0] === "push");
		assert.ok(pushCall, "git push called");
		assert.ok(
			pushCall.args.includes("origin") && pushCall.args.includes("feature-branch"),
			"push to origin/feature-branch",
		);

		// Info notification for push
		const infoNotifications = captured.notifications.filter((n) => n.type === "info");
		assert.ok(
			infoNotifications.some((n) => n.msg.includes("Changes committed and pushed")),
			"info notification for successful commit+push",
		);
	});

	it("Developer commitAndPush fails (git add error) → returns false, error notification", async () => {
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
		});

		// Git add fails
		setMockResponses({
			"git add -A": makeExecResult({ code: 1, stderr: "fatal: could not add" }),
		});

		const port = createMockPortForTest(pi);
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

		assert.equal(success, false, "commitAndPush failure returns false — pipeline stops");

		// Only the git add call was made (no commit/push)
		const gitCalls = captured.execCalls.filter((c) => c.cmd === "git");
		assert.equal(gitCalls.length, 1, "only git add was attempted");

		// Warning notification from handlePostAgentSuccess
		const warningNotifications = captured.notifications.filter((n) => n.type === "warning");
		assert.ok(
			warningNotifications.some((n) => n.msg.includes("commitAndPush failed")),
			"warning notification for commitAndPush failure",
		);

		// Also error notification from commitAndPush -> notify.error (through pushNotify)
		const errorNotifications = captured.notifications.filter((n) => n.type === "error");
		assert.ok(
			errorNotifications.some((n) => n.msg.includes("[git]")),
			"error notification from commitAndPush internal catch",
		);

		// Collector has error record
		const errors = collector.flush("stages");
		assert.ok(
			errors.some((e) => e.severity === "error" && e.message.includes("commitAndPush failed")),
			"collector receives error for commitAndPush failure",
		);
	});

	// ── Phase 5: Defense-in-depth — trailing code fence stripping ──

	it("Trailing ```json code fence stripped from commentBody before posting", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const result = makeResult({
			agentName: "researcher",
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "researcher",
				commentBody:
					'## Research Findings\n- Finding the first important research result\n- Finding the second important research result\n- Finding number three\n\n```json\n{\n  "action": "COMPLETE"',
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

		// Comment was posted (code fence stripped)
		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call");

		assert.equal(capturedBodies.length, 1, "one comment body captured");
		const body = capturedBodies[0] || "";

		// The ```json fence should be stripped
		assert.ok(!body.includes("```json"), "code fence stripped from posted comment");
		// Original content preserved
		assert.ok(
			body.includes("## Research Findings"),
			"original heading preserved after fence strip",
		);
		assert.ok(
			body.includes("Finding the first important"),
			"original content preserved after fence strip",
		);
	});

	// ── Phase 6: Extraction fallback chain reliability ─────────────

	it("Extraction fallback: textOnly empty, textOutput has JSON → extracted from textOutput with warn", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "researcher",
			textOnly: "",
			textOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "researcher",
				commentBody: "## Research Findings\n- Extracted from textOutput fallback",
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

		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call via fallback");

		assert.equal(capturedBodies.length, 1, "one comment body captured");
		assert.ok(
			capturedBodies[0].includes("Extracted from textOutput fallback"),
			"body content comes from textOutput",
		);

		const warns = collector.flush("stages");
		assert.ok(
			warns.some((w) => w.message.includes("result.textOutput (fallback after textOnly)")),
			"collector receives warn about extraction from textOutput fallback",
		);
	});

	it("Extraction fallback: textOnly empty, textOutput empty, thinkingOutput has JSON → extracted from thinkingOutput with warn", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "researcher",
			textOnly: "",
			textOutput: "",
			thinkingOutput: JSON.stringify({
				action: "COMPLETE",
				agentName: "researcher",
				commentBody: "## Research Findings\n- Extracted from thinkingOutput fallback",
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

		const ghCalls = captured.execCalls.filter(
			(c) => (c.cmd === "gh" || c.cmd === "bash") && c.args.some((a) => a === "comment"),
		);
		assert.equal(ghCalls.length, 1, "one gh issue comment call via fallback");

		assert.equal(capturedBodies.length, 1, "one comment body captured");
		assert.ok(
			capturedBodies[0].includes("Extracted from thinkingOutput fallback"),
			"body content comes from thinkingOutput",
		);

		const warns = collector.flush("stages");
		assert.ok(
			warns.some((w) => w.message.includes("result.thinkingOutput (fallback)")),
			"collector receives warn about extraction from thinkingOutput fallback",
		);
	});

	it("Extraction bare-text fallback: no JSON or structured heading → wraps in default heading", async () => {
		registerGhResponse();
		const pi = createBodyCapturePi(captured, capturedBodies);
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();
		const result = makeResult({
			agentName: "architect",
			textOnly: "",
			textOutput: "Architecture overview\n- Component A\n- Component B",
			thinkingOutput: undefined,
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
		assert.equal(ghCalls.length, 1, "one gh issue comment call via bare-text fallback");

		assert.equal(capturedBodies.length, 1, "one comment body captured");
		const body = capturedBodies[0] || "";
		assert.ok(body.includes("## Architecture"), "body has injected ## Architecture heading");
		assert.ok(body.includes("Architecture overview"), "body preserves original content");

		const warns = collector.flush("stages");
		assert.ok(
			warns.some((w) => w.message.includes("bare text fallback")),
			"collector receives warn about bare text fallback",
		);
	});

	// ── Phase 7: Heading validation — table-driven dispatch ─────

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
		const headingWarns = collector.flush("stages").filter(
			(w) => w.message.includes("heading"),
		);
		assert.equal(headingWarns.length, 0, "no heading-related warn messages");

		// Info notification for posted comment
		const infoNotifications = captured.notifications.filter((n) => n.type === "info");
		assert.ok(
			infoNotifications.some((n) => n.msg.includes("Posted architect comment")),
			"info notification for posted comment",
		);
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
		const headingWarns = collector.flush("stages").filter(
			(w) => w.message.includes("heading"),
		);
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
		const headingWarns = collector.flush("stages").filter(
			(w) => w.message.includes("heading"),
		);
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
