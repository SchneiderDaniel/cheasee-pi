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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OctokitPulls } from "../../github/octokit-pulls.ts";
import { mapRestPrToConflictInfo, mapPrToClosingRef } from "../../github/parsers.ts";
import { fakeTransport, createMockLogger } from "./fake-transport.mts";

const githubDir = dirname(fileURLToPath(import.meta.url));
const parsersPath = join(githubDir, "..", "..", "github", "parsers.ts");

// ─── Mock Logger ──────────────────────────────────────────────────

function pullsAdapter(octokit: Record<string, unknown>): OctokitPulls {
	return new OctokitPulls(fakeTransport({ octokit }), createMockLogger());
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

describe("OctokitPulls.listPullRequestsForBranch — REST adapter", () => {
	it("maps a REST-shaped pulls.list response to domain PrConflictInfo", async () => {
		const client = pullsAdapter({
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
		});

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
		const client = pullsAdapter({
			pulls: {
				list: mock.fn(async () => ({ data: [] })),
			},
		});
		const info = await client.listPullRequestsForBranch("branch", "owner/repo");
		assert.equal(info, null);
	});

	it("queries with head=owner:branch and state=open", async () => {
		const listMock = mock.fn(async (_opts: Record<string, unknown>) => ({ data: [] }));
		const client = pullsAdapter({ pulls: { list: listMock } });

		await client.listPullRequestsForBranch("worktree-git-issue-42", "owner/repo");
		const args = listMock.mock.calls[0]?.arguments[0] as Record<string, unknown>;
		assert.ok(args, "should call pulls.list with options");
		assert.equal(args.head, "owner:worktree-git-issue-42");
		assert.equal(args.state, "open");
	});

	it("invalid repo format throws", async () => {
		const client = pullsAdapter({});
		await assert.rejects(
			async () => await client.listPullRequestsForBranch("branch", "invalid-repo"),
			/Invalid repo format/,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// mapPrToClosingRef — pure Octokit response → ClosingPrRef translation
// Lives in parsers.ts so the merged/closed/open + keyword rules are
// unit-testable without HTTP mocks (issue #2102).
// ═══════════════════════════════════════════════════════════════════

describe("mapPrToClosingRef — response → ClosingPrRef mapping", () => {
	it("maps a merged PR with a closing keyword body", () => {
		const ref = mapPrToClosingRef(
			{
				number: 7,
				merged_at: "2025-01-01T00:00:00Z",
				state: "closed",
				merge_commit_sha: "abc",
				head: { ref: "b", sha: "h" },
				body: "This closes #42",
			},
			42,
		);
		assert.deepEqual(ref, {
			number: 7,
			sha: "abc",
			source: "closing-keyword",
			branch: "b",
			state: "merged",
		});
	});

	it("maps a closed-but-not-merged PR to state closed", () => {
		const ref = mapPrToClosingRef({ number: 7, merged_at: null, state: "closed" }, 42);
		assert.equal(ref.state, "closed");
	});

	it("maps an unmerged open PR to state open", () => {
		const ref = mapPrToClosingRef({ number: 7, merged_at: null, state: "open" }, 42);
		assert.equal(ref.state, "open");
	});

	it("falls back to head.sha when merge_commit_sha is null", () => {
		const ref = mapPrToClosingRef(
			{ number: 7, merge_commit_sha: null, head: { ref: "b", sha: "head-sha" } },
			42,
		);
		assert.equal(ref.sha, "head-sha");
	});

	it("returns empty sha and branch when merge_commit_sha and head are absent", () => {
		const ref = mapPrToClosingRef({ number: 7 }, 42);
		assert.equal(ref.sha, "");
		assert.equal(ref.branch, "");
	});

	it("classifies a missing body as branch-head", () => {
		assert.equal(mapPrToClosingRef({ number: 7 }, 42).source, "branch-head");
	});

	it("only counts closing keywords, not a bare mention", () => {
		assert.equal(
			mapPrToClosingRef({ number: 7, body: "See #42 for context" }, 42).source,
			"branch-head",
		);
		assert.equal(mapPrToClosingRef({ number: 7, body: "Fixes #42" }, 42).source, "closing-keyword");
		assert.equal(
			mapPrToClosingRef({ number: 7, body: "Closes #42." }, 42).source,
			"closing-keyword",
		);
	});

	it("anchors the closing keyword to the exact issue number", () => {
		assert.equal(mapPrToClosingRef({ number: 7, body: "closes #420" }, 42).source, "branch-head");
		assert.equal(mapPrToClosingRef({ number: 7, body: "closes #43" }, 42).source, "branch-head");
	});

	it("exposes exactly the ClosingPrRef keys — no REST field names leak", () => {
		const ref = mapPrToClosingRef(
			{
				number: 7,
				merged_at: null,
				state: "open",
				merge_commit_sha: null,
				head: { ref: "b", sha: "h" },
				body: "no keywords",
				base: { ref: "main" },
			},
			42,
		);
		assert.deepEqual(Object.keys(ref).sort(), ["branch", "number", "sha", "source", "state"]);
	});

	it("is importable from parsers.ts without a runtime cycle back to the adapter", () => {
		const source = readFileSync(parsersPath, "utf8");
		assert.equal(
			/from\s+["']\.\/octokit-client\.ts["']/.test(source),
			false,
			"parsers.ts must not import the adapter (runtime cycle)",
		);
		assert.equal(
			/^import\s+(?!type\s).*from\s+["']\.\/ports\.ts["']/m.test(source),
			false,
			"parsers.ts may only type-import ports.ts",
		);
		assert.ok(
			/import\s+type\s+\{[^}]*ClosingPrRef[^}]*\}\s*from\s+["']\.\/ports\.ts["']/.test(source),
			"parsers.ts must type-import ClosingPrRef from ports.ts",
		);
	});
});
