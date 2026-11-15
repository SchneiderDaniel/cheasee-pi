/**
 * CI gate three-way outcome contract (issue #1830).
 *
 * Fail-closed means the pipeline must not complete when CI cannot be
 * verified — but an unreachable or slow CI is not a code defect, so it must
 * STOP the pipeline with a blocker instead of looping the developer.
 *
 * Phase 1: pure policy — `classifyCiGate`
 * Phase 2: I/O + policy — `runCiGate`
 * Phase 3: decision precedence — `decideAudit`
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/ci-gate-outcomes.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	classifyCiGate,
	runCiGate,
	type CiGateOutcome,
	type PreGateDeps,
} from "../pipeline/audit/pre-gates.ts";
import { decideAudit } from "../pipeline/audit/aggregate.ts";
import type { CiPollResult } from "../checks/ci-gating.ts";
import type { SupervisorConfig } from "../config/types.ts";
import type { ExecFn } from "../../lib/port-types.ts";

// ── Fixtures / helpers ─────────────────────────────────────────────

const PUSHED_SHA = "pushedcommitsha1";

function ciResult(
	status: CiPollResult["status"],
	message = "ci message",
	failingChecks: string[] = [],
): CiPollResult {
	return { status, checks: [], failingChecks, message };
}

function makeDeps(overrides: Partial<PreGateDeps> = {}): PreGateDeps {
	return {
		pi: {} as unknown as ExtensionAPI,
		execFn: (async () => ({ code: 0, stdout: "", stderr: "" })) as unknown as ExecFn,
		ui: { notify: () => {} } as unknown as ExtensionCommandContext["ui"],
		repo: "owner/repo",
		branch: "feat/issue-1830",
		filteredData: { body: "", comments: [] },
		issueTitle: "ci infra blocker",
		...overrides,
	};
}

function makeConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
	return { ciGatingTimeoutSec: 30, defaultBranch: "main", ...overrides } as SupervisorConfig;
}

type NotifyCall = [message: string, level: string];

function notifySpy(sink: NotifyCall[]): ExtensionCommandContext["ui"] {
	return {
		notify: (message: string, level: string) => sink.push([message, level]),
	} as unknown as ExtensionCommandContext["ui"];
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1 — classifyCiGate: pure three-way policy
// ═══════════════════════════════════════════════════════════════════

describe("classifyCiGate — pass / fail / unverifiable (issue #1830 Phase 1)", () => {
	it("(entity) passing → pass", () => {
		assert.deepEqual(classifyCiGate(ciResult("passing", "All 3 CI check(s) completed.")), {
			kind: "pass",
		});
	});

	it("(entity) unconfigured → pass (a repo without CI never blocks)", () => {
		assert.deepEqual(classifyCiGate(ciResult("unconfigured", "No CI checks configured.")), {
			kind: "pass",
		});
	});

	it("(entity) failing → fail, text carries the --- CI Gate --- prefix and both names", () => {
		const outcome = classifyCiGate(
			ciResult("failing", "CI checks failing: build, e2e.", ["build", "e2e"]),
		);

		assert.equal(outcome.kind, "fail");
		const text = (outcome as { text: string }).text;
		assert.ok(text.startsWith("--- CI Gate"), text);
		assert.ok(text.split("\n")[0]!.startsWith("--- CI Gate (failing: build, e2e) ---"), text);
		assert.ok(text.includes("build"), text);
		assert.ok(text.includes("e2e"), text);
	});

	it("(entity) failing with no names → fail with the poll message, never an empty text", () => {
		const outcome = classifyCiGate(ciResult("failing", "CI checks failing.", []));

		assert.equal(outcome.kind, "fail");
		const text = (outcome as { text: string }).text;
		assert.ok(text.trim().length > 0, "text is never empty");
		assert.ok(text.includes("CI checks failing."), text);
		assert.match(text, /unknown/i, "the body says the names are unknown");
	});

	it("(entity) error → unverifiable with the poll message verbatim, no gate prefix", () => {
		const detail =
			"Could not look up the pull request for branch 'feat/x': gh: authentication failed.";
		const outcome = classifyCiGate(ciResult("error", detail));

		assert.equal(outcome.kind, "unverifiable");
		const reason = (outcome as { reason: string }).reason;
		assert.equal(reason, detail, "the gh error text is carried verbatim");
		assert.ok(!reason.startsWith("--- CI Gate ---"), "unverifiable reasons carry no gate prefix");
	});

	it("(entity) pending → unverifiable naming every still-pending check (AC2/AC3)", () => {
		const outcome = classifyCiGate(
			ciResult("pending", "CI checks still pending after 600s timeout: build, e2e."),
		);

		assert.equal(outcome.kind, "unverifiable");
		const reason = (outcome as { reason: string }).reason;
		assert.ok(reason.includes("build"), reason);
		assert.ok(reason.includes("e2e"), reason);
	});

	it("(entity) purity — the same input twice gives deepEqual results and no mutation", () => {
		const input = ciResult("failing", "CI checks failing: build.", ["build"]);
		const snapshot = structuredClone(input);

		const first = classifyCiGate(input);
		const second = classifyCiGate(input);

		assert.deepEqual(first, second);
		assert.deepEqual(input, snapshot, "the poll result is not mutated");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2 — runCiGate: I/O + policy
// ═══════════════════════════════════════════════════════════════════

describe("runCiGate — three-way outcome (issue #1830 Phase 2)", () => {
	it("(use-case) ciGatingTimeoutSec 0 → pass, poller never invoked", async () => {
		let invoked = false;
		const deps = makeDeps({
			pollCiChecksFn: async () => {
				invoked = true;
				return ciResult("error", "gh down");
			},
		});

		const outcome = await runCiGate(deps, makeConfig({ ciGatingTimeoutSec: 0 }), PUSHED_SHA);

		assert.deepEqual(outcome, { kind: "pass" });
		assert.equal(invoked, false, "a disabled gate polls nothing");
	});

	it("(use-case) ciGatingTimeoutSec undefined and -1 → pass, poller never invoked", async () => {
		let invoked = false;
		const deps = makeDeps({
			pollCiChecksFn: async () => {
				invoked = true;
				return ciResult("error", "gh down");
			},
		});

		const unset = await runCiGate(deps, makeConfig({ ciGatingTimeoutSec: undefined }), PUSHED_SHA);
		const negative = await runCiGate(deps, makeConfig({ ciGatingTimeoutSec: -1 }), PUSHED_SHA);

		assert.deepEqual(unset, { kind: "pass" });
		assert.deepEqual(negative, { kind: "pass" });
		assert.equal(invoked, false);
	});

	it("(use-case) poller throws Error → unverifiable naming it, exactly one warning", async () => {
		const notifyCalls: NotifyCall[] = [];
		const deps = makeDeps({
			ui: notifySpy(notifyCalls),
			pollCiChecksFn: async () => {
				throw new Error("boom");
			},
		});

		const outcome = await runCiGate(deps, makeConfig(), PUSHED_SHA);

		assert.equal(outcome.kind, "unverifiable");
		assert.ok((outcome as { reason: string }).reason.includes("boom"));
		assert.equal(notifyCalls.length, 1, "exactly one notification");
		assert.equal(notifyCalls[0]![1], "warning");
	});

	it("(use-case) poller throws a string → unverifiable naming it (non-Error boundary)", async () => {
		const deps = makeDeps({
			pollCiChecksFn: (async () => {
				throw "boom-string";
			}) as unknown as NonNullable<PreGateDeps["pollCiChecksFn"]>,
		});

		const outcome = await runCiGate(deps, makeConfig(), PUSHED_SHA);

		assert.equal(outcome.kind, "unverifiable");
		assert.ok((outcome as { reason: string }).reason.includes("boom-string"));
	});

	it("(use-case) gh API error → unverifiable carrying the gh text (AC1), one warning", async () => {
		const notifyCalls: NotifyCall[] = [];
		const detail =
			"Could not look up the pull request for branch 'feat/x': gh: authentication failed.";
		const deps = makeDeps({
			ui: notifySpy(notifyCalls),
			pollCiChecksFn: async () => ciResult("error", detail),
		});

		const outcome = await runCiGate(deps, makeConfig(), PUSHED_SHA);

		assert.equal(outcome.kind, "unverifiable");
		assert.ok(
			(outcome as { reason: string }).reason.includes("gh: authentication failed"),
			(outcome as { reason: string }).reason,
		);
		assert.equal(notifyCalls.length, 1);
		assert.equal(notifyCalls[0]![1], "warning");
	});

	it("(use-case) no open PR for the branch → unverifiable, never a developer loop", async () => {
		const notifyCalls: NotifyCall[] = [];
		const detail =
			"No open pull request found for branch 'feat/issue-1830'. CI gating requires a PR head SHA.";
		const deps = makeDeps({
			ui: notifySpy(notifyCalls),
			pollCiChecksFn: async () => ciResult("error", detail),
		});

		// The developer PR is upserted before Implementation → Audit
		// (stages/post-agent-success.ts), so a missing PR means the pushed state
		// is unverifiable: stop with a blocker instead of looping the developer.
		const outcome = await runCiGate(deps, makeConfig(), PUSHED_SHA);

		assert.equal(outcome.kind, "unverifiable");
		assert.ok(
			(outcome as { reason: string }).reason.includes("No open pull request found"),
			(outcome as { reason: string }).reason,
		);
		assert.equal(notifyCalls.length, 1);
		assert.equal(notifyCalls[0]![1], "warning");
	});

	it("(use-case) pending at timeout → unverifiable naming the checks, ciGatingTimeoutSec hint (AC2)", async () => {
		const notifyCalls: NotifyCall[] = [];
		const deps = makeDeps({
			ui: notifySpy(notifyCalls),
			pollCiChecksFn: async () =>
				ciResult("pending", "CI checks still pending after 30s timeout: build, e2e."),
		});

		const outcome = await runCiGate(deps, makeConfig(), PUSHED_SHA);

		assert.equal(outcome.kind, "unverifiable");
		assert.ok((outcome as { reason: string }).reason.includes("build"));
		assert.equal(notifyCalls.length, 1);
		assert.equal(notifyCalls[0]![1], "warning");
		assert.ok(
			notifyCalls[0]![0].includes("ciGatingTimeoutSec"),
			`notify must mention ciGatingTimeoutSec: ${notifyCalls[0]![0]}`,
		);
	});

	it("(use-case) passing → pass with zero notifications (silence preserved)", async () => {
		const notifyCalls: NotifyCall[] = [];
		const deps = makeDeps({
			ui: notifySpy(notifyCalls),
			pollCiChecksFn: async () => ciResult("passing", "All 3 CI check(s) completed successfully."),
		});

		assert.deepEqual(await runCiGate(deps, makeConfig(), PUSHED_SHA), { kind: "pass" });
		assert.equal(notifyCalls.length, 0);
	});

	it("(use-case) unconfigured → pass with exactly one warning (fail-open, never silent)", async () => {
		const notifyCalls: NotifyCall[] = [];
		const deps = makeDeps({
			ui: notifySpy(notifyCalls),
			pollCiChecksFn: async () =>
				ciResult("unconfigured", "No CI checks configured for this repo."),
		});

		assert.deepEqual(await runCiGate(deps, makeConfig(), PUSHED_SHA), { kind: "pass" });
		assert.equal(notifyCalls.length, 1);
		assert.equal(notifyCalls[0]![1], "warning");
	});

	it("(use-case) failing → fail with the byte-exact developer text and one warning", async () => {
		const notifyCalls: NotifyCall[] = [];
		const deps = makeDeps({
			ui: notifySpy(notifyCalls),
			pollCiChecksFn: async () => ciResult("failing", "CI checks failing: build.", ["build"]),
		});

		const outcome = await runCiGate(deps, makeConfig(), PUSHED_SHA);

		assert.deepEqual(outcome, {
			kind: "fail",
			text: "--- CI Gate (failing: build) ---\nCI checks failing: build.",
		});
		assert.equal(notifyCalls.length, 1);
		assert.ok(notifyCalls[0]![0].includes("build"), notifyCalls[0]![0]);
		assert.equal(notifyCalls[0]![1], "warning");
	});

	it("(use-case) missing expected head SHA with the gate enabled → unverifiable, poller never runs", async () => {
		let invoked = false;
		const deps = makeDeps({
			pollCiChecksFn: async () => {
				invoked = true;
				return ciResult("passing", "All checks passing.");
			},
		});

		const outcome = await runCiGate(deps, makeConfig(), "");

		assert.equal(outcome.kind, "unverifiable");
		assert.match((outcome as { reason: string }).reason, /expected head SHA/i);
		assert.equal(invoked, false);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3 — decideAudit: blocked beats fail, fail beats transition
// ═══════════════════════════════════════════════════════════════════

const CI_SECTION = "--- CI Gate (failing: build) ---\nCI checks failing: build.";
const DEAD_SECTION = "--- Dead Code Gate ---\nDEAD_CODE_FOUND: 1 finding(s) found (4 lines)";
const CI_ERROR =
	"Could not look up the pull request for branch 'feat/x': gh: authentication failed.";

const NO_RESULTS = {};

const unverifiable: CiGateOutcome = { kind: "unverifiable", reason: CI_ERROR };
const failing: CiGateOutcome = { kind: "fail", text: CI_SECTION };
const passing: CiGateOutcome = { kind: "pass" };

describe("decideAudit — blocked / transition precedence (issue #1830 Phase 3)", () => {
	it("(entity) CI unverifiable + other gate failures → blocked naming the CI error", () => {
		const decision = decideAudit([CI_SECTION, DEAD_SECTION], "note", NO_RESULTS, unverifiable);

		assert.equal(decision.outcome, "blocked");
		assert.equal((decision as { reason: string }).reason, CI_ERROR);
		assert.ok(!("nextStatus" in decision), "a blocked decision carries no nextStatus");
	});

	it("(entity) CI unverifiable + zero failures → blocked, not Audit (the fail-open hole)", () => {
		const decision = decideAudit([], "", NO_RESULTS, unverifiable);

		assert.equal(decision.outcome, "blocked");
		assert.ok(!("nextStatus" in decision));
	});

	it("(entity) CI fail + a dead-code failure → transition to Implementation, combined note", () => {
		const decision = decideAudit([CI_SECTION, DEAD_SECTION], "note", NO_RESULTS, failing);

		assert.equal(decision.outcome, "transition");
		assert.equal((decision as { nextStatus: string }).nextStatus, "Implementation");
		const note = (decision as { note: string }).note;
		assert.ok(note.includes(CI_SECTION), note);
		assert.ok(note.includes(DEAD_SECTION), note);
		assert.ok(note.includes("\n\n"), "sections are joined with a blank line");
	});

	it("(entity) CI unverifiable wins over fail when both are present", () => {
		const bothPresent = decideAudit([CI_SECTION], "note", NO_RESULTS, unverifiable);

		assert.equal(bothPresent.outcome, "blocked");
	});

	it("(entity) all gates pass → transition to Audit with the last note", () => {
		const decision = decideAudit([], "lsp ok", NO_RESULTS, passing);

		assert.equal(decision.outcome, "transition");
		assert.equal((decision as { nextStatus: string }).nextStatus, "Audit");
		assert.equal((decision as { note: string }).note, "lsp ok");
	});
});
