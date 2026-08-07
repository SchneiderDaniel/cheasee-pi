// ─── Tests: REST → domain PR conflict mapping (issue #1472) ───────
// The old listPullRequestsForBranch compared GraphQL-shaped fields
// (pr.mergeable === "CONFLICTING", pr.merge_state_status) against REST
// responses, so hasConflict was ALWAYS false in production. These tests
// pin the corrected REST mapping:
//   - mergeable: boolean | null   (null = background computation running)
//   - mergeable_state: "clean|dirty|unknown|blocked|unstable|behind|has_hooks|draft"
// Only "dirty" is a conflict; UNKNOWN is a poll-until-settled marker.

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { OctokitClient, mapRestPrToConflictInfo } from "../../github/octokit-client.ts";

// ─── Mock Logger ──────────────────────────────────────────────────

function createMockLogger() {
	return {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => createMockLogger(),
	};
}

// ═══════════════════════════════════════════════════════════════════
// mapRestPrToConflictInfo — pure REST → domain translation
// ═══════════════════════════════════════════════════════════════════

describe("mapRestPrToConflictInfo — REST → domain mapping", () => {
	it("dirty REST state maps to hasConflict=true (regression: pre-fix code never fired)", () => {
		const info = mapRestPrToConflictInfo(
			{ number: 42, mergeable: false, mergeable_state: "dirty" },
			"worktree-git-issue-42-foo",
			"main",
		);
		assert.equal(info.number, 42);
		assert.equal(info.hasConflict, true, "mergeable_state=dirty must map to hasConflict=true");
		assert.equal(info.mergeStateStatus, "DIRTY", "state normalized to domain convention");
		assert.equal(info.mergeable, "NOT_MERGEABLE", "mergeable must be a non-empty string");
	});

	it("clean REST state maps to hasConflict=false, no UNKNOWN leakage", () => {
		const info = mapRestPrToConflictInfo(
			{ number: 42, mergeable: true, mergeable_state: "clean" },
			"branch",
			"main",
		);
		assert.equal(info.hasConflict, false);
		assert.equal(info.mergeStateStatus, "CLEAN");
		assert.equal(info.mergeable, "MERGEABLE");
		assert.ok(!info.mergeable.includes("UNKNOWN"), "clean state must not leak UNKNOWN");
		assert.ok(!info.mergeStateStatus.includes("UNKNOWN"), "clean state must not leak UNKNOWN");
	});

	it("unknown REST state maps to hasConflict=false with UNKNOWN markers (gate polls)", () => {
		const info = mapRestPrToConflictInfo(
			{ number: 42, mergeable: null, mergeable_state: "unknown" },
			"branch",
			"main",
		);
		assert.equal(info.hasConflict, false, "unknown is not a conflict — gate polls instead");
		assert.equal(info.mergeable, "UNKNOWN", "null mergeable → UNKNOWN so the gate re-polls");
		assert.equal(info.mergeStateStatus, "UNKNOWN");
	});

	it("non-conflict REST states (blocked/unstable/behind/has_hooks/draft) are NOT conflicts", () => {
		for (const state of ["blocked", "unstable", "behind", "has_hooks", "draft"]) {
			const info = mapRestPrToConflictInfo(
				{ number: 42, mergeable: true, mergeable_state: state },
				"branch",
				"main",
			);
			assert.equal(
				info.hasConflict,
				false,
				`mergeable_state=${state} must NOT be a conflict (only dirty is)`,
			);
			assert.equal(info.mergeStateStatus, state.toUpperCase());
		}
	});

	it("missing mergeable_state defaults to UNKNOWN (poll, don't pass)", () => {
		const info = mapRestPrToConflictInfo({ number: 42, mergeable: null }, "branch", "main");
		assert.equal(info.hasConflict, false);
		assert.equal(info.mergeStateStatus, "UNKNOWN");
		assert.equal(info.mergeable, "UNKNOWN");
	});

	it("exposes exactly the domain keys — no REST field names leak upward", () => {
		const info = mapRestPrToConflictInfo(
			{ number: 42, mergeable: false, mergeable_state: "dirty", mergeable_state_extra: "x" },
			"branch",
			"main",
		);
		assert.deepEqual(Object.keys(info).sort(), [
			"baseRefName",
			"hasConflict",
			"headRefName",
			"mergeStateStatus",
			"mergeable",
			"number",
		]);
	});

	it("falls back to provided refs when head/base are missing", () => {
		const info = mapRestPrToConflictInfo({ number: 42 }, "fallback-head", "fallback-base");
		assert.equal(info.headRefName, "fallback-head");
		assert.equal(info.baseRefName, "fallback-base");
	});
});

// ═══════════════════════════════════════════════════════════════════
// listPullRequestsForBranch — integration with mocked octokit
// ═══════════════════════════════════════════════════════════════════

describe("OctokitClient.listPullRequestsForBranch — REST adapter", () => {
	it("maps a REST-shaped pulls.list response to domain PrConflictInfo", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = {
			pulls: {
				list: mock.fn(async () => ({
					data: [
						{
							number: 123,
							mergeable: false,
							mergeable_state: "dirty",
							head: { ref: "worktree-git-issue-42-foo" },
							base: { ref: "main" },
						},
					],
				})),
			},
		};

		const info = await client.listPullRequestsForBranch("worktree-git-issue-42-foo", "owner/repo");
		assert.ok(info, "should find the PR");
		assert.equal(info.number, 123);
		assert.equal(info.hasConflict, true, "dirty REST state must surface as a conflict");
		assert.equal(info.mergeStateStatus, "DIRTY");
		assert.equal(info.mergeable, "NOT_MERGEABLE");
		assert.equal(info.headRefName, "worktree-git-issue-42-foo");
		assert.equal(info.baseRefName, "main");
	});

	it("returns null for an empty pulls.list result", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		(client as any).octokit = {
			pulls: {
				list: mock.fn(async () => ({ data: [] })),
			},
		};
		const info = await client.listPullRequestsForBranch("branch", "owner/repo");
		assert.equal(info, null);
	});

	it("queries with head=owner:branch and state=open", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		const listMock = mock.fn(async (_opts: Record<string, unknown>) => ({ data: [] }));
		(client as any).octokit = { pulls: { list: listMock } };

		await client.listPullRequestsForBranch("worktree-git-issue-42", "owner/repo");
		const args = listMock.mock.calls[0]?.arguments[0] as Record<string, unknown>;
		assert.ok(args, "should call pulls.list with options");
		assert.equal(args.head, "owner:worktree-git-issue-42");
		assert.equal(args.state, "open");
	});

	it("invalid repo format throws", async () => {
		const client = new OctokitClient("fake-token", createMockLogger() as any);
		await assert.rejects(
			async () => await client.listPullRequestsForBranch("branch", "invalid-repo"),
			/Invalid repo format/,
		);
	});
});
