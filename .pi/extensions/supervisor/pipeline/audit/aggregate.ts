// ─── Pipeline Audit: Decision Aggregation ─────────────────────────
// Pure module (no pi/ctx imports — node:test-unit-testable without
// mocks): merges every gate failure into one combined note and decides
// the next status, or blocks the run when CI could not be verified.
// Precedence: unverifiable > fail > transition.

import type { DuplicateCodeResult } from "../../checks/duplicate-code.ts";
import type { DeadCodeResult } from "../../checks/dead-code.ts";
import type { OsvScanResult } from "../../checks/osv-scanner.ts";
import type { CiGateOutcome } from "./pre-gates.ts";

export interface AuditGateResults {
	duplicateCodeResult?: DuplicateCodeResult;
	deadCodeResult?: DeadCodeResult;
	vulnResult?: OsvScanResult;
}

/**
 * The Implementation → Audit verdict.
 *
 * - `transition` — a status change was decided (`Audit`, or `Implementation`
 *   when a gate failed and the developer loops back).
 * - `blocked`    — the run cannot be verified (CI unreachable / still pending).
 *   The pipeline stops and the issue status is left untouched; there is
 *   deliberately no `nextStatus` to apply.
 */
export type AuditDecision =
	| ({ outcome: "transition"; nextStatus: string; note: string } & AuditGateResults)
	| ({ outcome: "blocked"; reason: string } & AuditGateResults);

const CI_PASS: CiGateOutcome = { kind: "pass" };

/**
 * Decide the Implementation → Audit outcome from the CI verdict and the
 * aggregated gate failures.
 *
 * - CI unverifiable → `blocked` with the CI reason (precedence over every
 *   failure: stopping beats looping, and a loop would hand an infrastructure
 *   problem to the developer).
 * - Any failure → `transition` to "Implementation" with the combined note.
 * - All gates passed → `transition` to "Audit" with the last gate's note.
 *
 * Gate sections are joined with "\n\n" in the order they were pushed,
 * so the push order shapes the note byte-for-byte.
 */
export function decideAudit(
	failures: string[],
	lastNote: string,
	results: AuditGateResults = {},
	ciOutcome: CiGateOutcome = CI_PASS,
): AuditDecision {
	if (ciOutcome.kind === "unverifiable") {
		return { outcome: "blocked", reason: ciOutcome.reason, ...results };
	}

	if (failures.length > 0) {
		const combinedNote = failures.join("\n\n");
		return {
			outcome: "transition",
			nextStatus: "Implementation",
			note: `The following gates blocked the transition from Implementation to Audit:\n\n${combinedNote}`,
			...results,
		};
	}

	// All gates passed — proceed to Audit
	return {
		outcome: "transition",
		nextStatus: "Audit",
		note: lastNote || "",
		...results,
	};
}
