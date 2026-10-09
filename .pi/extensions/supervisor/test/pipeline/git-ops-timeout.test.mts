// ─── Tests: timed-out work preservation (issue #1987) ─────────────
// preserveTimedOutWork commits a marked wip(#N) commit and pushes it so a
// follow-up run resumes from the branch instead of restarting. Worktree
// recreation does `git reset --hard <remote>/<branch>`, so commit-only is
// insufficient — the push is a hard invariant. Fail-soft: a git failure
// returns { committed: false, error } and never throws.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	preserveTimedOutWork,
	parseWipCommit,
} from "../../pipeline/stages/git-ops.ts";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockPi(
	handle: (args: string[]) => { code: number; stdout?: string; stderr?: string },
	calls?: ExecCall[],
): ExtensionAPI {
	const log = calls || [];
	return {
		exec: (async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
			log.push({ cmd, args, opts: opts || {} });
			const r = handle(args);
			return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", killed: false };
		}) as ExtensionAPI["exec"],
	} as ExtensionAPI;
}

const notify = { info: () => {}, error: () => {} };
const SHA = "abc1234567890abc1234567890abc1234567890a";

/** Answers the commitAndPush argv sequence; overrides inject failures. */
function happyGit(overrides: (args: string[]) => { code: number; stdout?: string; stderr?: string } | null) {
	return makeMockPiAndHandler(overrides);
}

function makeMockPiAndHandler(
	overrides: (args: string[]) => { code: number; stdout?: string; stderr?: string } | null,
): { pi: ExtensionAPI; calls: ExecCall[] } {
	const calls: ExecCall[] = [];
	const pi = createMockPi((args) => {
		const override = overrides(args);
		if (override) return override;
		switch (args[0]) {
			case "status":
				return { code: 0, stdout: " M src/a.ts\n?? src/b.ts\n" };
			case "add":
				return { code: 0 };
			case "diff":
				return { code: 1, stdout: "src/a.ts\nsrc/b.ts\n" };
			case "commit":
				return { code: 0 };
			case "push":
				return { code: 0 };
			case "rev-parse":
				return { code: 0, stdout: `${SHA}\n` };
			default:
				return { code: 0 };
		}
	}, calls);
	return { pi, calls };
}

describe("parseWipCommit — git-log detection seam", () => {
	it("matches a wip(#N) subject and returns its short sha", () => {
		const log = `deadbeef feat(#1): other work\n${SHA} wip(#1987): partial work preserved on timeout\n`;
		const match = parseWipCommit(log, 1987);
		assert.equal(match?.sha, SHA);
	});

	it("returns null without a matching marker", () => {
		assert.equal(parseWipCommit(`${SHA} feat(#1987): real work\n`, 1987), null);
		assert.equal(parseWipCommit(`${SHA} wip(#9999): other issue\n`, 1987), null);
		assert.equal(parseWipCommit("", 1987), null);
	});
});

describe("preserveTimedOutWork — adapter (issue #1987)", () => {
	it("dirty worktree → commits and pushes, returns committed:true, sha and files", async () => {
		const { pi, calls } = happyGit(() => null);
		const result = await preserveTimedOutWork(pi, "/wt", "origin", "feature", 1987, notify);

		assert.equal(result.committed, true);
		assert.equal(result.sha, SHA);
		assert.deepEqual(result.files, ["src/a.ts", "src/b.ts"]);
		assert.equal(result.error, undefined);

		const commitCall = calls.find((c) => c.args[0] === "commit");
		assert.ok(commitCall, "git commit issued");
		assert.ok(
			(commitCall!.args[2] || "").includes("wip(#1987)"),
			`commit message carries the wip(#N) marker: ${commitCall!.args[2]}`,
		);
		assert.ok(
			calls.some((c) => c.args[0] === "push"),
			"git push issued (commit-only would be discarded by worktree recreate)",
		);
	});

	it("clean worktree → committed:false, files:[], no commit/push issued", async () => {
		const { pi, calls } = happyGit((args) => (args[0] === "status" ? { code: 0, stdout: "" } : null));
		const result = await preserveTimedOutWork(pi, "/wt", "origin", "feature", 1987, notify);

		assert.equal(result.committed, false);
		assert.deepEqual(result.files, []);
		assert.equal(result.error, undefined);
		assert.ok(!calls.some((c) => c.args[0] === "commit"), "no commit for a clean worktree");
		assert.ok(!calls.some((c) => c.args[0] === "push"), "no push for a clean worktree");
	});

	it("clean worktree but branch ahead of remote → pushes the unpushed commits and marks them wip", async () => {
		// Audit finding: a developer can commit locally and time out before
		// pushing. Worktree recreation resets to `<remote>/<branch>`, so the
		// clean-worktree early return must still push local-ahead commits.
		const { pi, calls } = happyGit((args) => {
			if (args[0] === "status") return { code: 0, stdout: "" };
			if (args[0] === "rev-list") return { code: 0, stdout: "2\n" };
			if (args[0] === "diff") return { code: 1, stdout: "src/a.ts\n" };
			return null;
		});
		const result = await preserveTimedOutWork(pi, "/wt", "origin", "feature", 1987, notify);

		assert.equal(result.committed, true);
		assert.equal(result.sha, SHA);
		assert.deepEqual(result.files, ["src/a.ts"]);
		assert.ok(
			calls.some((c) => c.args[0] === "commit" && (c.args[3] || "").includes("wip(#1987)")),
			"an empty marker commit makes the ahead work detectable for resume",
		);
		assert.ok(
			calls.some((c) => c.args[0] === "push"),
			"ahead commits pushed — reset --hard would discard them",
		);
	});

	it("fresh branch never pushed (remote ref absent) → falls back to base and preserves local commits", async () => {
		// Audit finding: `git rev-list <remote>/<branch>..HEAD` fails when the
		// feature branch was never pushed. Preservation must still push the
		// local-only commits or post-pipeline cleanup discards the only copy.
		const { pi, calls } = happyGit((args) => {
			if (args[0] === "status") return { code: 0, stdout: "" };
			if (args[0] === "rev-list" && (args[2] || "").startsWith("origin/feature..")) {
				return { code: 128, stderr: "unknown revision or path not in the working tree" };
			}
			if (args[0] === "rev-list") return { code: 0, stdout: "2\n" };
			if (args[0] === "diff") return { code: 1, stdout: "src/a.ts\n" };
			return null;
		});
		const result = await preserveTimedOutWork(pi, "/wt", "origin", "feature", 1987, notify, "main");

		assert.equal(result.committed, true);
		assert.equal(result.sha, SHA);
		assert.deepEqual(result.files, ["src/a.ts"]);
		assert.ok(
			calls.some((c) => c.args[0] === "rev-list" && c.args[2] === "origin/main..HEAD"),
			"falls back to the base ref when the tracking ref is absent",
		);
		assert.ok(
			calls.some((c) => c.args[0] === "commit" && (c.args[3] || "").includes("wip(#1987)")),
			"marker commit created so resume context detects the work",
		);
		assert.ok(
			calls.some((c) => c.args[0] === "push"),
			"local-only commits pushed — reset --hard would discard them",
		);
	});

	it("fresh branch at base (no local commits) → committed:false, no commit/push", async () => {
		const { pi, calls } = happyGit((args) => {
			if (args[0] === "status") return { code: 0, stdout: "" };
			if (args[0] === "rev-list" && (args[2] || "").startsWith("origin/feature..")) {
				return { code: 128, stderr: "unknown revision" };
			}
			if (args[0] === "rev-list") return { code: 0, stdout: "0\n" };
			return null;
		});
		const result = await preserveTimedOutWork(pi, "/wt", "origin", "feature", 1987, notify, "main");

		assert.equal(result.committed, false);
		assert.deepEqual(result.files, []);
		assert.equal(result.error, undefined);
		assert.ok(!calls.some((c) => c.args[0] === "commit"), "no marker commit for empty work");
		assert.ok(!calls.some((c) => c.args[0] === "push"), "no push for empty work");
	});

	it("clean worktree, rev-list failure → fail-soft {committed:false, error}", async () => {
		const { pi } = happyGit((args) => {
			if (args[0] === "status") return { code: 0, stdout: "" };
			if (args[0] === "rev-list") return { code: 128, stderr: "unknown revision" };
			return null;
		});
		const result = await preserveTimedOutWork(pi, "/wt", "origin", "feature", 1987, notify);
		assert.equal(result.committed, false);
		assert.ok(result.error && /git rev-list failed/.test(result.error), `error surfaced: ${result.error}`);
	});

	it("git add failure → fail-soft {committed:false, error}, no throw", async () => {
		const { pi } = happyGit((args) => (args[0] === "add" ? { code: 1, stderr: "boom" } : null));
		const result = await preserveTimedOutWork(pi, "/wt", "origin", "feature", 1987, notify);
		assert.equal(result.committed, false);
		assert.ok(result.error && /git add failed/.test(result.error), `error surfaced: ${result.error}`);
	});

	it("git push failure → fail-soft {committed:false, error}, no throw", async () => {
		const { pi } = happyGit((args) => (args[0] === "push" ? { code: 1, stderr: "rejected" } : null));
		const result = await preserveTimedOutWork(pi, "/wt", "origin", "feature", 1987, notify);
		assert.equal(result.committed, false);
		assert.ok(result.error && /git push failed/.test(result.error), `error surfaced: ${result.error}`);
	});

	it("git status failure → fail-soft {committed:false, error}", async () => {
		const { pi } = happyGit((args) => (args[0] === "status" ? { code: 128, stderr: "not a repo" } : null));
		const result = await preserveTimedOutWork(pi, "/wt", "origin", "feature", 1987, notify);
		assert.equal(result.committed, false);
		assert.ok(result.error && /git status failed/.test(result.error), `error surfaced: ${result.error}`);
	});
});
