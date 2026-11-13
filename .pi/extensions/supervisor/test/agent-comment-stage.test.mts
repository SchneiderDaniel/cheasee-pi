// ─── agent-comment stage — characterization (issue #2107) ───────────
// `handleAgentComment` owns the LLM-output → GitHub-comment policy for the
// architect, test-designer and researcher stages: the extraction fallback
// chain, the required-heading inject/skip table, the researcher empty-findings
// guard, the broken-```json fence strip, and graceful degradation.
//
// There was no direct suite for this module (only indirect coverage through
// `handlePostAgentSuccess`), so issue #2107 pinned the behaviour here BEFORE
// touching the file. Every case below is a contract: the posted body is the
// oracle, `collector.flush("stages")` is the warning oracle.
//
// Run: node --experimental-strip-types --test .pi/extensions/supervisor/test/agent-comment-stage.test.mts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { SupervisorConfig, AgentRunResult } from "../config/types.ts";
import { ErrorCollector } from "../pipeline/error-collector.ts";
import type { ErrorRecord } from "../pipeline/error-collector.ts";
import { handleAgentComment } from "../pipeline/stages/agent-comment.ts";
import type { GitHubPort } from "../github/ports.ts";
import { createMockGitHubPort } from "./helper/mock-github-port.ts";
import { CapturedOutput, createMockCtx, resetMocks } from "./helpers/capture.ts";

const ISSUE_NUM = 42;

/** Graceful-degradation text the stage posts when a researcher produces nothing. */
const RESEARCH_FALLBACK = "## Research Findings — No relevant results found for this topic.";

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

function makeResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
	return {
		output: "",
		success: true,
		agentName: "architect",
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

/** A structured agent payload carrying `commentBody`. */
function payload(agentName: string, commentBody: string): string {
	const json = JSON.stringify({ action: "COMPLETE", agentName, commentBody });
	return "```json\n" + json + "\n```";
}

interface StageRun {
	/** Every `postIssueComment` body, in call order. */
	posted: string[];
	/** Warnings the stage pushed to the `stages` source. */
	warns: ErrorRecord[];
	/** `ctx.ui.notify` calls (message + level). */
	notified: Array<{ msg: string; type?: string }>;
}

describe("handleAgentComment — characterization", () => {
	let captured: CapturedOutput;

	beforeEach(() => {
		captured = new CapturedOutput();
		resetMocks();
	});

	function portCapturing(posts: string[]): GitHubPort {
		return createMockGitHubPort({
			postIssueComment: async (_issueNum: number, _repo: string, body: string) => {
				posts.push(body);
			},
		});
	}

	async function run(agentName: string, result: AgentRunResult): Promise<StageRun> {
		const posted: string[] = [];
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();

		await handleAgentComment(
			ctx,
			result,
			agentName,
			ISSUE_NUM,
			mockConfig,
			collector,
			portCapturing(posted),
		);

		return {
			posted,
			warns: collector.flush("stages"),
			notified: captured.notifications.map((n) => ({ msg: n.msg, type: n.type })),
		};
	}

	// ── Extraction chain ────────────────────────────────────────────

	it("posts the structured commentBody from textOnly, verbatim and without warns", async () => {
		const body = "## Architecture\n\n- one seam, one owner";
		const stage = await run("architect", makeResult({ textOnly: payload("architect", body) }));

		assert.deepEqual(stage.posted, [body], "exactly one post, body unchanged");
		assert.deepEqual(stage.warns, [], "the primary source warns about nothing");
		assert.ok(
			stage.notified.some((n) => n.msg.includes("Posted architect comment on issue #42")),
			"notifies the poster",
		);
	});

	it("falls back to textOutput when textOnly is empty, and says so", async () => {
		const body = "## Architecture\n\n- from the instrumented log";
		const stage = await run(
			"architect",
			makeResult({ textOnly: "", textOutput: payload("architect", body) }),
		);

		assert.deepEqual(stage.posted, [body]);
		assert.equal(stage.warns.length, 1, "one fallback warning");
		assert.match(stage.warns[0].message, /extracted from result\.textOutput/);
	});

	it("falls back to thinkingOutput when both text sources are empty", async () => {
		const body = "## Architecture\n\n- from the thinking block";
		const stage = await run(
			"architect",
			makeResult({ textOnly: "", textOutput: "", thinkingOutput: payload("architect", body) }),
		);

		assert.deepEqual(stage.posted, [body]);
		assert.equal(stage.warns.length, 1);
		assert.match(stage.warns[0].message, /thinkingOutput \(fallback\)/);
	});

	it("wraps architect bare text in the ## Architecture heading", async () => {
		const stage = await run(
			"architect",
			makeResult({ textOnly: "", textOutput: "Architecture:\n- keep the port narrow" }),
		);

		assert.equal(stage.posted.length, 1);
		assert.ok(
			stage.posted[0].startsWith("## Architecture"),
			"bare text is wrapped in the role heading",
		);
		assert.match(stage.posted[0], /keep the port narrow/);
		assert.ok(stage.warns.some((w) => w.message.includes("bare text fallback")));
	});

	it("never posts raw subprocess stdout — the protocol-leak guard (#1671)", async () => {
		const stage = await run(
			"architect",
			makeResult({
				textOnly: "",
				textOutput: "",
				output: '## Test Plan\n\nagent_end event dump {"type":"agent_end"}',
			}),
		);

		assert.deepEqual(stage.posted, [], "raw result.output is never a comment source");
		assert.ok(
			stage.warns.some((w) => w.message.includes("no commentBody found")),
			"the empty extraction is surfaced",
		);
	});

	it("surfaces a zero-token, zero-tool, empty run", async () => {
		const stage = await run(
			"architect",
			makeResult({ textOnly: "", textOutput: "", tokenCount: 0, toolCount: 0 }),
		);

		assert.deepEqual(stage.posted, []);
		assert.ok(
			stage.warns.some((w) =>
				w.message.includes("produced no output (tokenCount=0, toolCount=0, empty text)"),
			),
			`expected the empty-run warning, got: ${stage.warns.map((w) => w.message).join(" | ")}`,
		);
	});

	// ── Required-heading table ──────────────────────────────────────

	it('injects the "## Test Plan" heading a test-designer body is missing', async () => {
		const stage = await run(
			"test-designer",
			makeResult({ textOnly: payload("test-designer", "### Scenario A\n- step one") }),
		);

		assert.equal(stage.posted.length, 1);
		assert.ok(stage.posted[0].startsWith("## Test Plan\n\n"), "heading is prepended");
		assert.match(stage.posted[0], /### Scenario A/);
		assert.ok(
			stage.warns.some((w) => w.message.includes('missing "## Test Plan" heading. Injecting')),
			"the injection is surfaced",
		);
	});

	it("leaves an architect body that already carries its heading alone", async () => {
		const body = "## Architecture\n\n- untouched";
		const stage = await run("architect", makeResult({ textOnly: payload("architect", body) }));

		assert.deepEqual(stage.posted, [body]);
		assert.equal(
			stage.warns.some((w) => w.message.includes("heading")),
			false,
			"no heading warning when the heading is present",
		);
	});

	it("skips a researcher body without its heading and posts graceful degradation", async () => {
		const stage = await run(
			"researcher",
			makeResult({ textOnly: payload("researcher", "## Something Else\n\n- a fact") }),
		);

		assert.deepEqual(stage.posted, [RESEARCH_FALLBACK], "the body itself is not posted");
		assert.ok(
			stage.notified.some((n) => n.msg.includes("(graceful degradation)")),
			"the degradation is visible in the UI",
		);
		assert.ok(
			stage.warns.some((w) => w.message.includes('missing "## Research Findings" heading')),
			"the skip is surfaced",
		);
	});

	// ── Researcher validation ───────────────────────────────────────

	it("replaces a researcher body with no substantive findings", async () => {
		const stage = await run(
			"researcher",
			makeResult({
				textOnly: payload("researcher", "## Research Findings\n\n### Best Practices\n- —"),
			}),
		);

		assert.deepEqual(stage.posted, [RESEARCH_FALLBACK], "empty findings degrade");
		assert.ok(
			stage.warns.some((w) => w.message.includes("no substantive findings")),
			"the replacement is surfaced",
		);
	});

	it("keeps a researcher body that does carry findings", async () => {
		const body = "## Research Findings\n\n- the pinned analyzer scores raw text";
		const stage = await run("researcher", makeResult({ textOnly: payload("researcher", body) }));

		assert.deepEqual(stage.posted, [body]);
		assert.equal(
			stage.warns.some((w) => w.message.includes("no substantive findings")),
			false,
		);
	});

	// ── Broken-fence strip + budget header ──────────────────────────

	it("strips a trailing broken json fence after substantive prose", async () => {
		const prose = "## Architecture\n\n" + "The seam stays where it is. ".repeat(4);
		const brokenFence = "```json\n" + '{"action":"COMPLETE"';
		const stage = await run(
			"architect",
			makeResult({ textOnly: payload("architect", prose + "\n" + brokenFence) }),
		);

		assert.equal(stage.posted.length, 1);
		assert.equal(
			stage.posted[0].includes("```json"),
			false,
			"the trailing fence never reaches the issue",
		);
		assert.ok(stage.posted[0].includes("The seam stays where it is."));
	});

	it("replaces the heading with the budget header when research stopped early", async () => {
		const stage = await run(
			"researcher",
			makeResult({
				textOnly: payload("researcher", "## Research Findings\n\n- partial fact"),
				budgetExceeded: true,
				tokenCount: 12345,
			}),
		);

		assert.equal(stage.posted.length, 1);
		assert.ok(
			stage.posted[0].startsWith(
				"## Research Findings — Research stopped early: agent exceeded token budget (12345 tokens used).",
			),
			`unexpected body: ${stage.posted[0]}`,
		);
		assert.match(stage.posted[0], /partial fact/, "the partial findings survive");
	});

	// ── Refusal ─────────────────────────────────────────────────────

	it("posts nothing for a refused run — the handler owns refusals", async () => {
		const refusal = '```json\n{"refusal":"the worktree has no lock file"}\n```';
		const stage = await run("architect", makeResult({ textOnly: refusal, textOutput: refusal }));

		assert.deepEqual(stage.posted, [], "no comment on a refusal");
		assert.deepEqual(stage.warns, [], "and no spurious warnings either");
	});

	// ── Port absence ────────────────────────────────────────────────

	it("notifies without posting when no port is threaded in", async () => {
		const ctx = createMockCtx(captured, { hasUI: true });
		const collector = new ErrorCollector();

		await handleAgentComment(
			ctx,
			makeResult({
				agentName: "architect",
				textOnly: payload("architect", "## Architecture\n\n- x"),
			}),
			"architect",
			ISSUE_NUM,
			mockConfig,
			collector,
			undefined,
		);

		assert.ok(
			captured.notifications.some((n) => n.msg.includes("Posted architect comment")),
			"the UI still reports the comment",
		);
		assert.deepEqual(collector.flush("stages"), [], "no port is not an error");
	});
});
