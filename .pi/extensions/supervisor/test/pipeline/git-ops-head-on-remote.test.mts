// ─── Tests: pushed-commit detection + conditional uncommit (issue #1829) ──
// A gate loop-back must not rewrite history that is already on the remote:
// `uncommitDeveloperWork` skips the soft reset when HEAD is reachable from
// `<remote>/<branch>`, skips it (and surfaces the error) when the check cannot
// answer, and only resets an unpushed HEAD.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline/git-ops-head-on-remote.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isHeadOnRemote } from "../../pipeline/stages/git-ops.ts";
import { uncommitDeveloperWork } from "../../pipeline/stages/audit-rejection-ops.ts";
import { ErrorCollector } from "../../pipeline/error-collector.ts";
import type { ExecFn } from "../../../lib/port-types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIT_TS = resolve(__dirname, "../../pipeline/audit/index.ts");

const WT = "/wt/issue-1829";
const REMOTE = "origin";
const BRANCH = "worktree-git-issue-1829-test";
const ANCESTOR_ARGV = ["merge-base", "--is-ancestor", "HEAD", `${REMOTE}/${BRANCH}`];
const RESET_ARGV = ["reset", "--soft", "HEAD~1"];

// ─── Fixtures ─────────────────────────────────────────────────────

interface GitCall {
	cmd: string;
	args: string[];
}

type Answer = { code: number; stdout?: string; stderr?: string } | "throw";

/** Fake exec: answers the ancestor probe and the soft reset, records argv. */
function makeExec(
	answer: Answer,
	calls: GitCall[] = [],
	resetAnswer: Answer = { code: 0 },
): ExecFn {
	return (async (cmd: string, args: string[]) => {
		calls.push({ cmd, args: [...(args ?? [])] });
		const argv = (args ?? []).join(" ");
		const result = argv.startsWith("merge-base --is-ancestor")
			? answer
			: argv.startsWith("reset --soft")
				? resetAnswer
				: { code: 0 };
		if (result === "throw") throw new Error("git exploded");
		return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	}) as unknown as ExecFn;
}

interface NotifyCall {
	message: string;
	level: string;
}

function makeUi(): { ui: ExtensionCommandContext["ui"]; notifyCalls: NotifyCall[] } {
	const notifyCalls: NotifyCall[] = [];
	return {
		notifyCalls,
		ui: {
			notify: (message: string, level: string) => notifyCalls.push({ message, level }),
			setStatus: () => {},
		} as unknown as ExtensionCommandContext["ui"],
	};
}

const resetCalls = (calls: GitCall[]): GitCall[] =>
	calls.filter((c) => c.args.join(" ") === RESET_ARGV.join(" "));

// ─── Phase 4a: isHeadOnRemote ─────────────────────────────────────

describe("isHeadOnRemote (issue #1829)", () => {
	it("(adapter) merge-base --is-ancestor exits 0 → on-remote", async () => {
		const calls: GitCall[] = [];
		const result = await isHeadOnRemote(makeExec({ code: 0 }, calls), WT, REMOTE, BRANCH);

		assert.equal(result.status, "on-remote");
		assert.deepEqual(calls[0]!.args, ANCESTOR_ARGV);
	});

	it("(adapter) exit 1 → not-on-remote", async () => {
		const result = await isHeadOnRemote(makeExec({ code: 1 }), WT, REMOTE, BRANCH);
		assert.equal(result.status, "not-on-remote");
	});

	it("(adapter) exit 128 (unknown ref) → unknown, never throws", async () => {
		const result = await isHeadOnRemote(
			makeExec({ code: 128, stderr: "fatal: Not a valid object name" }),
			WT,
			REMOTE,
			BRANCH,
		);

		assert.equal(result.status, "unknown");
		assert.match(result.error ?? "", /Not a valid object name/);
	});

	it("(adapter) exec throws → unknown, never throws", async () => {
		const result = await isHeadOnRemote(makeExec("throw"), WT, REMOTE, BRANCH);
		assert.equal(result.status, "unknown");
		assert.match(result.error ?? "", /git exploded/);
	});
});

// ─── Phase 4b: uncommitDeveloperWork ──────────────────────────────

describe("uncommitDeveloperWork — only an unpushed HEAD is uncommitted (issue #1829)", () => {
	it("(use-case) HEAD on the remote → no soft reset, warning says uncommit was skipped", async () => {
		const calls: GitCall[] = [];
		const { ui, notifyCalls } = makeUi();
		const collector = new ErrorCollector();

		const status = await uncommitDeveloperWork(
			makeExec({ code: 0 }, calls),
			WT,
			REMOTE,
			BRANCH,
			ui,
			collector,
		);

		assert.equal(status, "skipped-on-remote");
		assert.deepEqual(resetCalls(calls), [], "a pushed commit must never be rewritten");
		const warning = notifyCalls.find((c) => c.level === "warning");
		assert.ok(warning, "skipping is surfaced, never silent");
		assert.match(warning!.message, /preserved/i);
		assert.equal(collector.size, 0, "skipping is not an error");
	});

	it("(use-case) HEAD not on the remote → exactly one soft reset", async () => {
		const calls: GitCall[] = [];
		const { ui } = makeUi();

		const status = await uncommitDeveloperWork(
			makeExec({ code: 1 }, calls),
			WT,
			REMOTE,
			BRANCH,
			ui,
			new ErrorCollector(),
		);

		assert.equal(status, "uncommitted");
		assert.equal(resetCalls(calls).length, 1);
	});

	it("(use-case) unknown → no reset, the git error reaches the warning and the collector", async () => {
		const calls: GitCall[] = [];
		const { ui, notifyCalls } = makeUi();
		const collector = new ErrorCollector();

		const status = await uncommitDeveloperWork(
			makeExec({ code: 128, stderr: "fatal: not a git repository" }, calls),
			WT,
			REMOTE,
			BRANCH,
			ui,
			collector,
		);

		assert.equal(status, "unknown");
		assert.deepEqual(resetCalls(calls), [], "never rewrite history on an unknown answer");
		const warning = notifyCalls.find((c) => c.level === "warning");
		assert.ok(warning, "the failure is surfaced");
		assert.match(warning!.message, /not a git repository/);
		assert.ok(
			collector.all.some((r) => r.message.includes("not a git repository")),
			"collector carries the git error (never log-only)",
		);
	});
});

// ─── Phase 4c: structure pin ──────────────────────────────────────

describe("audit/index.ts — the gate is pinned to the captured HEAD (issue #1829)", () => {
	it("(structure) the HEAD capture precedes runPreGates and feeds runCiGate as its third argument", () => {
		const src = readFileSync(AUDIT_TS, "utf-8");
		const captureIdx = src.indexOf("const expectedHeadSha = ");
		const preGatesIdx = src.indexOf("await runPreGates(");

		assert.ok(captureIdx >= 0, "runTscAndLspAudit captures the pushed commit SHA");
		assert.ok(preGatesIdx >= 0, "runPreGates call exists");
		assert.ok(
			captureIdx < preGatesIdx,
			"the SHA capture must precede the gates so the polled commit is the pushed one",
		);
		assert.ok(
			src.includes("runCiGate(deps, config, expectedHeadSha)"),
			"runCiGate receives the captured SHA as its third argument",
		);
	});

	it("(structure) uncommitDeveloperWork is only called when a gate failed", () => {
		const src = readFileSync(AUDIT_TS, "utf-8");
		const guardIdx = src.indexOf("if (gateFailures.length > 0) {");
		const uncommitIdx = src.indexOf("await uncommitDeveloperWork(");

		assert.ok(guardIdx >= 0, "gate-failure guard present");
		assert.ok(uncommitIdx > guardIdx, "the uncommit runs inside the gate-failure branch");
	});
});
