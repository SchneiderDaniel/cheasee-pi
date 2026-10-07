/**
 * Tests for audit package — sendUserMessage with deliverAs: "followUp" removal (Issue #604)
 *
 * Phase 1: No sendUserMessage/deliverAs delivery path (behavior spies)
 * Phase 2: CI failure path preserves behavior (ctx.ui.notify, gateFailures aggregation)
 * Phase 3: TSC checkpoint notify level preserves behavior (ctx.ui.notify info/warning)
 *
 * Issue #1407: audit.ts split into pipeline/audit/* — CI failure behavior lives
 * in pre-gates.ts, TSC failure behavior in tsc-gate.ts, and the failure
 * aggregation (gateFailures.push) in the orchestrator index.ts.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/audit-sendusermessage.test.mts
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { runCiGate, type PreGateDeps } from "../pipeline/audit/pre-gates.ts";
import * as auditGateDecision from "../checks/audit-gate-decision.ts";
import type { SupervisorConfig } from "../config/types.ts";
import type { TscCheckpointResult } from "../../lib/tsc-types.ts";

// runTscAndLspAudit / runTscGate are driven through module mocks
// (--experimental-test-module-mocks). Without the flag the mocked suites skip;
// the CI-failure behavior test below still runs.
const hasMockModule = typeof mock.module === "function";

// The TSC runner returned by the mocked getRunGate("tsc"); set per test.
let tscCheckpointResult: TscCheckpointResult = { hasErrors: false, diagnostics: [] };

if (hasMockModule) {
	// getRunGate() dynamically imports an extensionless directory path that the
	// test runner cannot resolve — replace it with a controllable stub while
	// keeping the real decision frame.
	mock.module("../checks/audit-gate-decision.ts", {
		namedExports: {
			...auditGateDecision,
			getRunGate: (async () => async () => tscCheckpointResult) as unknown,
		},
	});
	// LSP pre-audit is heavy (spawns the language server) — stub it out.
	mock.module("../pipeline/audit/lsp-gate.ts", {
		namedExports: {
			runLspPreAudit: (async () => ({ nextStatus: "Audit", note: "lsp ok" })) as unknown,
		},
	});
	// The pre-gates shell out to jscpd/knip/gh/osv — stub them clean.
	mock.module("../pipeline/audit/pre-gates.ts", {
		namedExports: {
			runCiGate: (async () => ({})) as unknown,
			runDuplicateGate: (async () => ({
				dupResult: { status: "no_jscpd", clones: [], totalDuplicateLines: 0, changedFilesScanned: [] },
			})) as unknown,
			runDeadCodeGate: (async () => ({
				deadResult: { status: "no_knip", findings: [], totalDeadLines: 0, changedFilesScanned: [] },
			})) as unknown,
			runPackageSafetyGate: (async () => ({})) as unknown,
			runOsvGate: (async () => ({
				vulnResult: {
					status: "no_osv_scanner",
					findings: [],
					counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
				},
			})) as unknown,
			runTraceabilityGate: (async () => ({})) as unknown,
		},
	});
}

// ===========================================================================
// deliverAs / sendUserMessage removal — observed behavior (Issue #604)
// ===========================================================================
// The audit flow is driven with message spies. The old source scan is gone:
// the contract is "no delivery path ever emits sendUserMessage or a deliverAs
// option", which is exactly what the spies observe.

function makeConfig(): SupervisorConfig {
	return {
		ciGatingTimeoutSec: 0,
		defaultBranch: "main",
		branchPrefix: "worktree-",
		repo: "owner/repo",
	} as SupervisorConfig;
}

if (hasMockModule) {
	describe("pipeline/audit — no sendUserMessage / deliverAs delivery (Phase 1)", () => {
		it("audit flow never calls sendUserMessage nor passes deliverAs", async () => {
			const sendMessage = mock.fn();
			const sendUserMessage = mock.fn();
			const pi = {
				exec: async () => ({ code: 0, stdout: "", stderr: "" }),
				sendMessage,
				sendUserMessage,
			} as any;
			const ctx = { cwd: "/repo", ui: { notify: mock.fn(), setStatus: mock.fn() } } as any;
			tscCheckpointResult = { hasErrors: false, diagnostics: [] };

			const { runTscAndLspAudit } = await import("../pipeline/audit/index.ts");
			await runTscAndLspAudit(
				604,
				"deliverAs removal",
				makeConfig(),
				"developer",
				{ body: "", comments: [] },
				"/wt/issue-604",
				pi,
				ctx,
				undefined,
			);

			assert.equal(sendUserMessage.mock.callCount(), 0, "no sendUserMessage delivery path");
			for (const call of sendMessage.mock.calls) {
				assert.equal(
					Object.prototype.hasOwnProperty.call(call.arguments[0], "deliverAs"),
					false,
					"sendMessage never carries a deliverAs option",
				);
			}
		});
	});
}

// ===========================================================================
// CI failure path — observed behavior (Phase 2)
// ===========================================================================

describe("pipeline/audit — CI failure path preserves behavior (Phase 2)", () => {
	it("failing CI produces the CI Gate section and a warning notification", async () => {
		const notify = mock.fn();
		const deps = {
			pi: {} as any,
			execFn: (async () => ({ code: 0, stdout: "", stderr: "" })) as any,
			ui: { notify } as any,
			repo: "owner/repo",
			branch: "feat/x",
			filteredData: { body: "", comments: [] },
			issueTitle: "t",
			pollCiChecksFn: (async () => ({
				status: "failing",
				checks: [{ name: "build", conclusion: "failure" }],
				message: "CI build failed",
			})) as any,
		} as PreGateDeps;

		const result = await runCiGate(
			deps,
			{ ciGatingTimeoutSec: 30, defaultBranch: "main" } as SupervisorConfig,
			"/wt",
		);

		assert.equal(result.failureText, "--- CI Gate ---\nCI build failed");
		assert.equal(notify.mock.callCount(), 1);
		assert.equal(notify.mock.calls[0]!.arguments[1], "warning");
		assert.ok(String(notify.mock.calls[0]!.arguments[0]).includes("CI checks failing"));
	});
});

// ===========================================================================
// TSC gate notify level — observed behavior (Phase 3)
// ===========================================================================

if (hasMockModule) {
	describe("pipeline/audit — TSC failure path preserves behavior (Phase 3)", () => {
		it("a clean TSC run notifies the success note at info level and returns null", async () => {
			const notify = mock.fn();
			const ctx = { ui: { notify } } as any;
			tscCheckpointResult = { hasErrors: false, diagnostics: [] };
			const { runTscGate } = await import("../pipeline/audit/tsc-gate.ts");

			const failureText = await runTscGate("/wt", ctx, undefined);

			assert.equal(failureText, null);
			assert.equal(notify.mock.callCount(), 1);
			assert.equal(notify.mock.calls[0]!.arguments[1], "info");
			assert.ok(String(notify.mock.calls[0]!.arguments[0]).includes("no type errors"));
		});

		it("a TSC error returns the TypeScript Checkpoint section and warns", async () => {
			const notify = mock.fn();
			const ctx = { ui: { notify } } as any;
			tscCheckpointResult = {
				hasErrors: true,
				diagnostics: [
					{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "boom", filePath: "/wt/a.ts" },
				],
			};
			const { runTscGate } = await import("../pipeline/audit/tsc-gate.ts");

			const failureText = await runTscGate("/wt", ctx, undefined);

			assert.ok(failureText?.startsWith("--- TypeScript Checkpoint ---"));
			assert.equal(notify.mock.calls[0]!.arguments[1], "warning");
			assert.equal(notify.mock.calls[1]!.arguments[1], "info");
		});
	});
}
