// ─── Tests: CI-gate rejection counter + comment (issue #1829) ─────
// `bumpRejectCounter` owns the `reject-N` label grammar for both loop-back
// paths; `postCiGateRejection` posts one `## CI Gate Failed` comment naming
// the red checks and rolls the counter back if that comment cannot be saved.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline/ci-gate-rejection.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMockGitHubPort, type PortCall } from "../helper/mock-github-port.ts";
import type { SupervisorConfig } from "../../config/types.ts";
import {
	bumpRejectCounter,
	postCiGateRejection,
} from "../../pipeline/stages/audit-rejection-ops.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import { isAuditRejectionComment } from "../../lib/audit-headings.ts";
import { findPriorAuditRejection } from "../../lib/audit-rejections.ts";

// ─── Fixtures ─────────────────────────────────────────────────────

const CONFIG: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {},
	maxRejections: 5,
	codeowners: ["user1"],
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

const ISSUE = 42;

interface NotifyCall {
	message: string;
	level: string;
}

function makeCtx(): { ctx: ExtensionCommandContext; notifyCalls: NotifyCall[] } {
	const notifyCalls: NotifyCall[] = [];
	return {
		notifyCalls,
		ctx: {
			cwd: "/repo",
			ui: {
				notify: (message: string, level: string) => notifyCalls.push({ message, level }),
				setStatus: () => {},
			},
		} as unknown as ExtensionCommandContext,
	};
}

const CI_NOTE = "--- CI Gate (failing: build, lint) ---\nCI checks failing: build, lint.";

const labelsFrom = (calls: PortCall[]): string[] =>
	calls.filter((c) => c.method === "addIssueLabel").map((c) => String(c.args[2]));

const removedLabelsFrom = (calls: PortCall[]): string[] =>
	calls.filter((c) => c.method === "removeIssueLabel").map((c) => String(c.args[2]));

const commentsFrom = (calls: PortCall[]): string[] =>
	calls.filter((c) => c.method === "postIssueComment").map((c) => String(c.args[2]));

// ─── Phase 3a: bumpRejectCounter ──────────────────────────────────

describe("bumpRejectCounter (issue #1829)", () => {
	it("(use-case) reject-2 present → adds reject-3, removes reject-2, returns 3", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({ getIssueLabels: async () => ["reject-2"] }, calls);
		const collector = new ErrorCollector();

		const next = await bumpRejectCounter(port, ISSUE, CONFIG.repo, collector);

		assert.equal(next, 3);
		assert.deepEqual(labelsFrom(calls), ["reject-3"]);
		assert.deepEqual(removedLabelsFrom(calls), ["reject-2"]);
		assert.equal(collector.size, 0, "the happy path warns about nothing");
	});

	it("(use-case) no reject labels → adds reject-1, returns 1, no remove call", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({ getIssueLabels: async () => ["bug", "audit"] }, calls);

		const next = await bumpRejectCounter(port, ISSUE, CONFIG.repo);

		assert.equal(next, 1);
		assert.deepEqual(labelsFrom(calls), ["reject-1"]);
		assert.deepEqual(removedLabelsFrom(calls), []);
	});

	it("(use-case) addIssueLabel rejects → throws, no comment posted, collector carries the failure", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				getIssueLabels: async () => [],
				addIssueLabel: async () => {
					throw new Error("label API down");
				},
			},
			calls,
		);
		const collector = new ErrorCollector();

		await assert.rejects(
			() => bumpRejectCounter(port, ISSUE, CONFIG.repo, collector),
			/label API down/,
		);
		assert.deepEqual(commentsFrom(calls), [], "no comment is posted for an uncounted loop-back");
		assert.ok(
			collector.all.some((r) => r.message.includes("label API down")),
			"the collector records the failure",
		);
	});

	it("(use-case) getIssueLabels rejects → throws (an uncounted loop-back must not happen)", async () => {
		const collector = new ErrorCollector();
		const port = createMockGitHubPort({
			getIssueLabels: async () => {
				throw new Error("cannot read labels");
			},
		});

		await assert.rejects(
			() => bumpRejectCounter(port, ISSUE, CONFIG.repo, collector),
			/cannot read labels/,
		);
		assert.ok(collector.all.some((r) => r.message.includes("cannot read labels")));
	});

	it("(use-case) removing the stale label fails → returns N+1 with a collector warning", async () => {
		const port = createMockGitHubPort({
			getIssueLabels: async () => ["reject-2"],
			removeIssueLabel: async () => {
				throw new Error("remove failed");
			},
		});
		const collector = new ErrorCollector();

		const next = await bumpRejectCounter(port, ISSUE, CONFIG.repo, collector);

		assert.equal(next, 3);
		assert.ok(
			collector.all.some((r) => r.severity === "warn" && r.message.includes("remove failed")),
			"the stale-label failure is surfaced as a warning",
		);
	});
});

// ─── Phase 3b: postCiGateRejection ────────────────────────────────

describe("postCiGateRejection (issue #1829)", () => {
	it("(use-case) posts exactly one `## CI Gate Failed` comment naming every failing check", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort({ getIssueLabels: async () => [] }, calls);
		const { ctx } = makeCtx();

		const next = await postCiGateRejection(ISSUE, CONFIG, CI_NOTE, 2, undefined, port, ctx);

		assert.equal(next, 1);
		const comments = commentsFrom(calls);
		assert.equal(comments.length, 1, "exactly one rejection comment");
		assert.ok(
			comments[0]!.startsWith("## CI Gate Failed"),
			`comment must open with the CI gate heading: ${comments[0]}`,
		);
		assert.ok(comments[0]!.includes("build"), comments[0]!);
		assert.ok(comments[0]!.includes("lint"), comments[0]!);
	});

	it("(use-case) comment post fails → reject-(N+1) removed and the error rethrown", async () => {
		const calls: PortCall[] = [];
		const port = createMockGitHubPort(
			{
				getIssueLabels: async () => ["reject-1"],
				postIssueComment: async () => {
					throw new Error("comment API down");
				},
			},
			calls,
		);
		const collector = new ErrorCollector();
		const { ctx } = makeCtx();

		await assert.rejects(
			() => postCiGateRejection(ISSUE, CONFIG, CI_NOTE, 2, collector, port, ctx),
			/comment API down/,
		);

		assert.deepEqual(labelsFrom(calls), ["reject-2"]);
		assert.deepEqual(
			removedLabelsFrom(calls),
			["reject-1", "reject-2"],
			"the stale reject-1 label is retired and reject-2 is rolled back",
		);
		assert.equal(
			removedLabelsFrom(calls).at(-1),
			"reject-2",
			"the advanced label is removed last — the counter is not left advanced",
		);
		assert.ok(
			collector.all.some((r) => r.severity === "error" && r.message.includes("comment API down")),
		);
	});

	it("(use-case) two successive CI blocks → reject-1 then reject-2, one label per block", async () => {
		const calls: PortCall[] = [];
		let labels: string[] = [];
		const port = createMockGitHubPort(
			{
				getIssueLabels: async () => [...labels],
				addIssueLabel: async (_issueNum: number, _repo: string, label: string) => {
					labels = [...labels.filter((l) => l !== label), label];
				},
				removeIssueLabel: async (_issueNum: number, _repo: string, label: string) => {
					labels = labels.filter((l) => l !== label);
				},
			},
			calls,
		);
		const { ctx } = makeCtx();

		const first = await postCiGateRejection(ISSUE, CONFIG, CI_NOTE, 1, undefined, port, ctx);
		const second = await postCiGateRejection(ISSUE, CONFIG, CI_NOTE, 2, undefined, port, ctx);

		assert.equal(first, 1);
		assert.equal(second, 2);
		assert.deepEqual(labelsFrom(calls), ["reject-1", "reject-2"]);
		assert.equal(commentsFrom(calls).length, 2, "one comment per block");
		assert.deepEqual(labels, ["reject-2"], "the label carries the count");
	});
});

// ─── Phase 3c: heading grammar stays audit-only ───────────────────

describe("isAuditRejectionComment — CI headings are not audit rejections (issue #1829)", () => {
	it("(entity) `## CI Gate Failed` and `## Rejection Limit Reached` are not audit rejections", () => {
		assert.equal(isAuditRejectionComment("## CI Gate Failed — build"), false);
		assert.equal(isAuditRejectionComment("## Rejection Limit Reached"), false);
	});

	it("(entity) findPriorAuditRejection ignores a comment list holding only CI headings", () => {
		const prior = findPriorAuditRejection([
			{ id: "IC_1", body: "## CI Gate Failed — build\n\nfix it" },
			{ id: "IC_2", body: "## Rejection Limit Reached\n\nstopping" },
		]);
		assert.equal(prior, undefined);
	});
});
