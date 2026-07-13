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
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, AgentRunResult, FilteredIssueData } from "../config/types.ts";
import { ErrorCollector } from "../pipeline/error-collector.ts";
import { handlePostAgentSuccess } from "../pipeline/stages.ts";
import { createMockGitHubPort } from "./helper/mock-github-port.ts";
import type { GitHubPort } from "../github/ports.ts";
import { join } from "node:path";

// Module-level stub port for tests that don't need gh comment verification
const mockPort = createMockGitHubPort();

/**
 * Create a mock port whose postIssueComment delegates to pi.exec for gh calls,
 * allowing the body-capture shim to intercept and record bodies. Other methods
 * use default stub values.
 */
function createMockPortForTest(pi: ExtensionAPI): GitHubPort {
	return createMockGitHubPort({
		postIssueComment: async (issueNum, repo, body) => {
			const tempDir = "ignore";
			const tempFile = join(tempDir, `comment-body-${issueNum}-${Date.now()}.md`);
			mkdirSync(tempDir, { recursive: true });
			writeFileSync(tempFile, body, "utf-8");
			try {
				await pi.exec("gh", [
					"issue",
					"comment",
					String(issueNum),
					"--repo",
					repo,
					"--body-file",
					tempFile,
				]);
			} finally {
				try {
					unlinkSync(tempFile);
				} catch {
					// best-effort cleanup
				}
			}
		},
	});
}
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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

		const success = await handlePostAgentSuccess(
			createMockPortForTest(pi),
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
});
