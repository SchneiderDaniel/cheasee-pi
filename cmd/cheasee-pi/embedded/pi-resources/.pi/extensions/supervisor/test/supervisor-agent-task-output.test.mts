/**
 * Tests for structured auditor output parsing (Phase 3).
 *
 * Phase 3: buildAgentTask("auditor") simplified to structured output markers
 * - No gh issue comment, gh pr create, heredoc shell in prompt
 * - Uses AUDIT_DECISION, PR_TITLE, PR_BODY, COMMENT_BODY
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-agent-task-output.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Phase 3: buildAgentTask("auditor") simplified prompt
// ---------------------------------------------------------------------------

describe("buildAgentTask — auditor simplified (Phase 3)", () => {
	it("no longer contains gh issue comment", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			!task.includes("gh issue comment"),
			"Auditor prompt should not contain gh issue comment",
		);
	});

	it("no longer contains gh pr create", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(!task.includes("gh pr create"), "Auditor prompt should not contain gh pr create");
	});

	it("no longer contains shell heredoc (cat >)", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(!task.includes("cat >"), "Auditor prompt should not contain shell heredoc");
	});

	it("no longer contains SUMMARY_FILE variable", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(!task.includes("SUMMARY_FILE"), "Auditor prompt should not contain SUMMARY_FILE");
	});

	it("contains JSON structured output with action markers", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			task.includes('"action": "APPROVED"'),
			"Auditor prompt should contain APPROVED action",
		);
		assert.ok(
			task.includes('"action": "REJECTED"'),
			"Auditor prompt should contain REJECTED action",
		);
	});

	it("contains prTitle / prBody / commentBody JSON keys", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(task.includes('"prTitle"'), "Auditor prompt should contain prTitle");
		assert.ok(task.includes('"prBody"'), "Auditor prompt should contain prBody");
		assert.ok(task.includes('"commentBody"'), "Auditor prompt should contain commentBody");
	});

	it("still includes code review instructions", async () => {
		const { buildAgentTask } = await import("../agent/task.ts");
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/test/main/repo",
		);
		assert.ok(
			task.includes("Review Findings"),
			"Auditor prompt should include review dimensions in output template",
		);
	});
});
