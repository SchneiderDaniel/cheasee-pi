// ─── Phase 10: GitHub pull-request adapter ───────────────────────
// R3.AC4: the draft PR is un-drafted through GraphQL only — REST silently
// ignores `draft: false` and would report a false success.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	GitHubPullRequestAdapter,
	MARK_READY_FOR_REVIEW_MUTATION,
	type OctokitLike,
} from "../adapters/github-pull-request.ts";

interface Recorded {
	rest: Array<{ method: string; params: Record<string, unknown> }>;
	graphql: Array<{ query: string; variables: Record<string, unknown> }>;
}

function fakeClient(overrides: {
	create?: (params: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
	update?: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
	get?: (params: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
	graphql?: (query: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>;
}): { client: OctokitLike; recorded: Recorded } {
	const recorded: Recorded = { rest: [], graphql: [] };
	const client: OctokitLike = {
		rest: {
			pulls: {
				async create(params) {
					recorded.rest.push({ method: "create", params: params as Record<string, unknown> });
					return (
						overrides.create
							? await overrides.create(params as Record<string, unknown>)
							: { data: { number: 12, node_id: "node-12" } }
					) as never;
				},
				async update(params) {
					recorded.rest.push({ method: "update", params: params as Record<string, unknown> });
					return overrides.update
						? await overrides.update(params as Record<string, unknown>)
						: { data: {} };
				},
				async get(params) {
					recorded.rest.push({ method: "get", params: params as Record<string, unknown> });
					return (
						overrides.get
							? await overrides.get(params as Record<string, unknown>)
							: { data: { number: 12, state: "open", draft: false } }
					) as never;
				},
			},
		},
		async graphql(query, variables) {
			recorded.graphql.push({ query, variables });
			return overrides.graphql
				? await overrides.graphql(query, variables)
				: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
		},
	};
	return { client, recorded };
}

describe("openDraft", () => {
	it("creates a draft PR and captures number plus node id", async () => {
		const { client, recorded } = fakeClient({});
		const adapter = new GitHubPullRequestAdapter(client, "owner/repo");

		const opened = await adapter.openDraft({
			branch: "goal/x",
			base: "main",
			title: "goal: x",
			body: "body",
		});
		assert.equal(opened.ok, true);
		if (opened.ok) assert.deepEqual(opened.value, { number: 12, nodeId: "node-12" });

		assert.equal(recorded.rest[0]!.method, "create");
		assert.equal(recorded.rest[0]!.params.draft, true);
		assert.equal(recorded.rest[0]!.params.head, "goal/x");
		assert.equal(recorded.rest[0]!.params.base, "main");
		assert.equal(recorded.rest[0]!.params.owner, "owner");
		assert.equal(recorded.rest[0]!.params.repo, "repo");
	});

	it("fails when the response carries no node id, never claiming readiness", async () => {
		const { client } = fakeClient({ create: async () => ({ data: { number: 5 } }) });
		const adapter = new GitHubPullRequestAdapter(client, "owner/repo");
		const opened = await adapter.openDraft({ branch: "b", base: "main", title: "t", body: "b" });
		assert.equal(opened.ok, false);
		if (!opened.ok) assert.match(opened.error, /without a node id/);
	});

	it("maps a client rejection to a failed Result", async () => {
		const { client } = fakeClient({
			create: async () => {
				throw new Error("401 Bad credentials");
			},
		});
		const adapter = new GitHubPullRequestAdapter(client, "owner/repo");
		const opened = await adapter.openDraft({ branch: "b", base: "main", title: "t", body: "b" });
		assert.equal(opened.ok, false);
		if (!opened.ok) assert.match(opened.error, /401 Bad credentials/);
	});

	it("rejects a malformed repository", async () => {
		const { client } = fakeClient({});
		const adapter = new GitHubPullRequestAdapter(client, "no-slash");
		const opened = await adapter.openDraft({ branch: "b", base: "main", title: "t", body: "b" });
		assert.equal(opened.ok, false);
		if (!opened.ok) assert.match(opened.error, /expected "owner\/repo"/);
	});
});

describe("markReadyForReview", () => {
	it("uses the GraphQL mutation with the node id", async () => {
		const { client, recorded } = fakeClient({});
		const adapter = new GitHubPullRequestAdapter(client, "owner/repo");

		const ready = await adapter.markReadyForReview("node-12");
		assert.equal(ready.ok, true);
		assert.equal(recorded.graphql.length, 1);
		assert.equal(recorded.graphql[0]!.query, MARK_READY_FOR_REVIEW_MUTATION);
		assert.match(MARK_READY_FOR_REVIEW_MUTATION, /markPullRequestReadyForReview/);
		assert.deepEqual(recorded.graphql[0]!.variables, { pullRequestId: "node-12" });
	});

	it("never calls the REST update route", async () => {
		const { client, recorded } = fakeClient({});
		const adapter = new GitHubPullRequestAdapter(client, "owner/repo");
		await adapter.markReadyForReview("node-12");
		assert.equal(
			recorded.rest.some((call) => call.method === "update"),
			false,
			"REST silently ignores draft:false",
		);
	});

	it("fails when GraphQL returns no PR, never reporting ready", async () => {
		const { client } = fakeClient({ graphql: async () => ({}) });
		const adapter = new GitHubPullRequestAdapter(client, "owner/repo");
		const ready = await adapter.markReadyForReview("node-12");
		assert.equal(ready.ok, false);
		if (!ready.ok) assert.match(ready.error, /returned no pull request/);
	});

	it("maps a GraphQL error to a failed Result with the API message", async () => {
		const { client } = fakeClient({
			graphql: async () => {
				throw new Error("Resource not accessible by integration");
			},
		});
		const adapter = new GitHubPullRequestAdapter(client, "owner/repo");
		const ready = await adapter.markReadyForReview("node-12");
		assert.equal(ready.ok, false);
		if (!ready.ok) assert.match(ready.error, /Resource not accessible/);
	});
});

describe("getState / updateBody", () => {
	const cases: Array<[Record<string, unknown>, string]> = [
		[{ number: 1, state: "open", draft: true }, "draft"],
		[{ number: 1, state: "open", draft: false }, "open"],
		[{ number: 1, state: "closed", draft: false }, "closed"],
		[{ number: 1, state: "closed", draft: false, merged_at: "2026-01-02T00:00:00Z" }, "merged"],
	];

	for (const [data, expected] of cases) {
		it(`maps ${expected} from the REST payload`, async () => {
			const { client } = fakeClient({ get: async () => ({ data }) });
			const adapter = new GitHubPullRequestAdapter(client, "owner/repo");
			const state = await adapter.getState(1);
			assert.equal(state.ok, true);
			if (state.ok) assert.equal(state.value, expected);
		});
	}

	it("sends the given body", async () => {
		const { client, recorded } = fakeClient({});
		const adapter = new GitHubPullRequestAdapter(client, "owner/repo");
		const updated = await adapter.updateBody({ number: 12, body: "new body" });
		assert.equal(updated.ok, true);
		assert.equal(recorded.rest[0]!.params.body, "new body");
		assert.equal(recorded.rest[0]!.params.pull_number, 12);
	});

	it("returns a failed Result on update failure", async () => {
		const { client } = fakeClient({
			update: async () => {
				throw new Error("validation failed");
			},
		});
		const adapter = new GitHubPullRequestAdapter(client, "owner/repo");
		const updated = await adapter.updateBody({ number: 12, body: "x" });
		assert.equal(updated.ok, false);
		if (!updated.ok) assert.match(updated.error, /validation failed/);
	});

	it("returns a failed Result on a get failure", async () => {
		const { client } = fakeClient({
			get: async () => {
				throw new Error("network down");
			},
		});
		const adapter = new GitHubPullRequestAdapter(client, "owner/repo");
		const state = await adapter.getState(1);
		assert.equal(state.ok, false);
		if (!state.ok) assert.match(state.error, /network down/);
	});
});

describe("adapter surface", () => {
	it("exposes no merge and no close operation", () => {
		const { client } = fakeClient({});
		const adapter = new GitHubPullRequestAdapter(client, "owner/repo");
		const surface = adapter as unknown as Record<string, unknown>;
		assert.equal(surface.merge, undefined);
		assert.equal(surface.close, undefined);
		assert.equal(surface.mergePullRequest, undefined);
		assert.equal(surface.closePullRequest, undefined);
	});
});
