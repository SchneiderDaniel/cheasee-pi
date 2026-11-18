// ─── Tests: OctokitClient — comment update and label CRUD ────────
// In-place comment update (#2044), label CRUD, paginated comment
// discovery and the authenticated identity. The internal Octokit instance
// is mocked: these are write paths against the real GitHub API.

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { OctokitClient } from "../../github/octokit-client.ts";
import { createMockLogger } from "../helper/octokit-fixtures.mts";

// ═══════════════════════════════════════════════════════════════════════
// issue #2044 — in-place comment update + label CRUD
// ═══════════════════════════════════════════════════════════════════════

describe("OctokitClient.updateIssueComment (issue #2044)", () => {
	it("dispatches a numeric id to the REST updateComment endpoint", async () => {
		const updateComment = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { updateComment } };

		await client.updateIssueComment("123456", "owner/repo", "## Audit Rejected\nx");

		assert.equal(updateComment.mock.callCount(), 1);
		const params = updateComment.mock.calls[0]!.arguments[0] as {
			comment_id: number;
			body: string;
		};
		assert.equal(params.comment_id, 123456);
		assert.equal(params.body, "## Audit Rejected\nx");
	});

	it("dispatches an opaque node id to the GraphQL updateIssueComment mutation", async () => {
		const graphqlMock = mock.fn(async (_q: string) => ({ updateIssueComment: {} }));
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { updateComment: mock.fn() } };
		(client as any)._graphql = graphqlMock;

		await client.updateIssueComment("IC_kwDOabc", "owner/repo", "## Audit Rejected\nx");

		assert.equal(graphqlMock.mock.callCount(), 1);
		const query = graphqlMock.mock.calls[0]!.arguments[0] as string;
		assert.ok(query.includes("updateIssueComment"), "must use the updateIssueComment mutation");
		assert.ok(query.includes("IC_kwDOabc"), "must carry the comment node id");
	});

	it("invalid repo format throws", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		await assert.rejects(
			() => client.updateIssueComment("1", "invalid", "x"),
			/Invalid repo format/,
		);
	});
});

describe("OctokitClient label CRUD (issue #2044)", () => {
	it("getIssueLabels returns label names", async () => {
		const listLabelsOnIssue = mock.fn(async (_params: Record<string, unknown>) => ({
			data: [{ name: "reject-1" }, { name: "bug" }],
		}));
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { listLabelsOnIssue } };

		assert.deepEqual(await client.getIssueLabels(42, "owner/repo"), ["reject-1", "bug"]);
	});

	it("getIssueLabels paginates until a short page", async () => {
		const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: `l${i}` }));
		const listLabelsOnIssue = mock.fn(async (params: Record<string, unknown>) =>
			(params as { page: number }).page === 1 ? { data: fullPage } : { data: [{ name: "tail" }] },
		);
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { listLabelsOnIssue } };

		const labels = await client.getIssueLabels(42, "owner/repo");
		assert.equal(labels.length, 101);
		assert.equal(labels[100], "tail");
		assert.equal(listLabelsOnIssue.mock.callCount(), 2);
	});

	it("addIssueLabel adds without replacing existing labels", async () => {
		const addLabels = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { addLabels } };

		await client.addIssueLabel(42, "owner/repo", "reject-2");
		const params = addLabels.mock.calls[0]!.arguments[0] as { labels: string[] };
		assert.deepEqual(params.labels, ["reject-2"]);
	});

	it("removeIssueLabel tolerates a missing label (404)", async () => {
		const removeLabel = mock.fn(async () => {
			throw Object.assign(new Error("Label does not exist"), { status: 404 });
		});
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { removeLabel } };

		await client.removeIssueLabel(42, "owner/repo", "reject-1");
		assert.equal(removeLabel.mock.callCount(), 1);
	});

	it("removeIssueLabel rethrows non-404 errors", async () => {
		const removeLabel = mock.fn(async () => {
			throw Object.assign(new Error("forbidden"), { status: 403 });
		});
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { removeLabel } };

		await assert.rejects(() => client.removeIssueLabel(42, "owner/repo", "reject-1"), /forbidden/);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// issue #2044 audit finding #4 — paginated comment discovery + identity
// ═══════════════════════════════════════════════════════════════════════

describe("OctokitClient.listComments (issue #2044 audit finding #4)", () => {
	it("paginates until a short page", async () => {
		const fullPage = Array.from({ length: 100 }, (_, i) => ({
			id: i + 1,
			user: { login: "u" },
			body: `c${i}`,
		}));
		const listComments = mock.fn(async (params: Record<string, unknown>) =>
			(params as { page: number }).page === 1
				? { data: fullPage }
				: { data: [{ id: 101, user: null, body: "tail" }] },
		);
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { issues: { listComments } };

		const comments = await client.listComments(42, "owner/repo");
		assert.equal(comments.length, 101);
		assert.deepEqual(comments[0], { id: "1", author: { login: "u" }, body: "c0" });
		assert.deepEqual(comments[100], { id: "101", author: undefined, body: "tail" });
		assert.equal(listComments.mock.callCount(), 2);
	});

	it("invalid repo format throws", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		await assert.rejects(() => client.listComments(1, "invalid"), /Invalid repo format/);
	});
});

describe("OctokitClient.getAuthenticatedLogin (issue #2044)", () => {
	it("returns the authenticated user's login", async () => {
		const getAuthenticated = mock.fn(async () => ({ data: { login: "automation" } }));
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = { users: { getAuthenticated } };

		assert.equal(await client.getAuthenticatedLogin(), "automation");
		assert.equal(getAuthenticated.mock.callCount(), 1);
	});
});
