// ─── Tests: computeAuditGateRejection (issue #1533 extraction) ────
// Unit tests for the gateRejected pre-compute extracted from
// runAgentLoop into stages/auditor-output.ts. The helper posts no
// comments — it only computes + warns via notify when the gate rejects.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRunResult, SupervisorConfig } from "../../config/types.ts";
import { computeAuditGateRejection, createStageState } from "../../pipeline/stages/index.ts";
import type { StageState } from "../../pipeline/stages/index.ts";

const CONFIG = { auditScoreThreshold: 0.75 } as unknown as SupervisorConfig;

function makeResult(overrides: Partial<AgentRunResult>): AgentRunResult {
	return {
		output: "raw output",
		success: true,
		agentName: "auditor",
		toolCount: 5,
		tokenCount: 1000,
		durationMs: 10000,
		textOutput: "",
		textOnly: "",
		summaryLine: "summary",
		errorOutput: "",
		...overrides,
	};
}

function approvedOutput(findings: unknown[]): string {
	return [
		"## Audit Complete",
		"",
		"```json",
		JSON.stringify({ action: "APPROVED", agentName: "auditor", findings }),
		"```",
	].join("\n");
}

function notifySpy(): { notify: ReturnType<typeof mock.fn>; ctx: ExtensionCommandContext } {
	const notify = mock.fn();
	const ctx = {
		ui: { notify, setStatus: () => {}, setWidget: mock.fn(), confirm: async () => true },
	} as unknown as ExtensionCommandContext;
	return { notify, ctx };
}

describe("computeAuditGateRejection — gate pre-compute (issue #1533)", () => {
	it("non-auditor agent → undefined", () => {
		const { ctx } = notifySpy();
		const result = computeAuditGateRejection(
			"developer",
			makeResult({ agentName: "developer", textOutput: approvedOutput([]) }),
			CONFIG,
			createStageState("Implementation"),
			ctx,
		);
		assert.equal(result, undefined);
	});

	it("auditor !success → undefined", () => {
		const { ctx } = notifySpy();
		const result = computeAuditGateRejection(
			"auditor",
			makeResult({ success: false }),
			CONFIG,
			createStageState("Audit"),
			ctx,
		);
		assert.equal(result, undefined);
	});

	it("success without textOutput → undefined", () => {
		const { ctx } = notifySpy();
		const result = computeAuditGateRejection(
			"auditor",
			makeResult({ textOutput: "" }),
			CONFIG,
			createStageState("Audit"),
			ctx,
		);
		assert.equal(result, undefined);
	});

	it("unparseable textOutput → undefined", () => {
		const { ctx } = notifySpy();
		const result = computeAuditGateRejection(
			"auditor",
			makeResult({ textOutput: "plain text, no JSON structure at all" }),
			CONFIG,
			createStageState("Audit"),
			ctx,
		);
		assert.equal(result, undefined);
	});

	it("action !== APPROVED → undefined", () => {
		const { ctx } = notifySpy();
		const textOutput = [
			"## Audit",
			"",
			"```json",
			JSON.stringify({
				action: "REJECTED",
				agentName: "auditor",
				findings: [
					{
						severity: "critical",
						dimension: "code-quality",
						symptom: "s",
						consequence: "c",
						remedy: "r",
					},
				],
			}),
			"```",
		].join("\n");
		const result = computeAuditGateRejection(
			"auditor",
			makeResult({ textOutput }),
			CONFIG,
			createStageState("Audit"),
			ctx,
		);
		assert.equal(result, undefined);
	});

	it("APPROVED without findings → undefined", () => {
		const { ctx } = notifySpy();
		const result = computeAuditGateRejection(
			"auditor",
			makeResult({ textOutput: approvedOutput([]) }),
			CONFIG,
			createStageState("Audit"),
			ctx,
		);
		assert.equal(result, undefined);
	});

	it("score exactly at threshold → undefined (passes)", () => {
		const { ctx } = notifySpy();
		// 8 active dimensions, threshold 0.75 → required 6. One failed
		// dimension → 7/8 ≥ 6 → gate passes.
		const textOutput = approvedOutput([
			{
				severity: "critical",
				dimension: "code-quality",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
		]);
		const result = computeAuditGateRejection(
			"auditor",
			makeResult({ textOutput }),
			CONFIG,
			createStageState("Audit"),
			ctx,
		);
		assert.equal(result, undefined);
	});

	it("score one below threshold → GateRejected{score, required, total} + warning notify", () => {
		const { notify, ctx } = notifySpy();
		// 3 failed dimensions → 5/8 < 6 → gate rejects.
		const textOutput = approvedOutput([
			{
				severity: "critical",
				dimension: "code-quality",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
			{
				severity: "warning",
				dimension: "test-quality",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
			{
				severity: "warning",
				dimension: "completeness",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
		]);
		const result = computeAuditGateRejection(
			"auditor",
			makeResult({ textOutput }),
			CONFIG,
			createStageState("Audit"),
			ctx,
		);
		assert.ok(result, "gate rejected");
		assert.equal(result.score.passing, 5);
		assert.equal(result.score.total, 8);
		assert.equal(result.required, 6);
		assert.equal(result.total, 8);
		assert.ok(notify.mock.calls.length >= 1, "warning notify fired on rejection");
		const message = String(notify.mock.calls[0]?.arguments[0]);
		assert.ok(message.includes("Audit score gate rejected"), "notify names the gate rejection");
	});

	it("suggestion findings do NOT fail dimensions (passes)", () => {
		const { ctx } = notifySpy();
		const textOutput = approvedOutput([
			{
				severity: "suggestion",
				dimension: "code-quality",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
		]);
		const result = computeAuditGateRejection(
			"auditor",
			makeResult({ textOutput }),
			CONFIG,
			createStageState("Audit"),
			ctx,
		);
		assert.equal(result, undefined, "suggestions do not lower the score");
	});

	it("researcherSkipped shrinks total dimensions (7 active)", () => {
		const { ctx } = notifySpy();
		const state: StageState = createStageState("Audit");
		state.researcherSkipped = true;
		// 7 active dimensions, threshold 0.75 → required 6. 3 failed →
		// 4/7 < 6 → gate rejects with total 7.
		const textOutput = approvedOutput([
			{
				severity: "critical",
				dimension: "code-quality",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
			{
				severity: "warning",
				dimension: "test-quality",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
			{
				severity: "warning",
				dimension: "completeness",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
		]);
		const result = computeAuditGateRejection(
			"auditor",
			makeResult({ textOutput }),
			CONFIG,
			state,
			ctx,
		);
		assert.ok(result, "gate rejected with researcher skipped");
		assert.equal(result.total, 7);
	});

	it("no warning notify when gate passes", () => {
		const { notify, ctx } = notifySpy();
		const textOutput = approvedOutput([
			{
				severity: "critical",
				dimension: "code-quality",
				symptom: "s",
				consequence: "c",
				remedy: "r",
			},
		]);
		computeAuditGateRejection(
			"auditor",
			makeResult({ textOutput }),
			CONFIG,
			createStageState("Audit"),
			ctx,
		);
		assert.equal(notify.mock.calls.length, 0, "no notify when gate passes");
	});
});
