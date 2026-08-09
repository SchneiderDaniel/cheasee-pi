// ─── Pipeline Audit: Decision Aggregation ─────────────────────────
// Pure module (no pi/ctx imports — node:test-unit-testable without
// mocks): merges every gate failure into one combined note and decides
// the next status. Implementation if ANY gate failed, Audit otherwise.

import type { DuplicateCodeResult } from "../../checks/duplicate-code.ts";
import type { DeadCodeResult } from "../../checks/dead-code.ts";
import type { OsvScanResult } from "../../checks/osv-scanner.ts";

export interface AuditGateResults {
	duplicateCodeResult?: DuplicateCodeResult;
	deadCodeResult?: DeadCodeResult;
	vulnResult?: OsvScanResult;
}

export interface AuditDecision extends AuditGateResults {
	nextStatus: string;
	note: string;
}

/**
 * Decide the Implementation → Audit transition outcome from the
 * aggregated gate failures.
 *
 * - Any failure → "Implementation" with the combined gate note.
 * - All gates passed → "Audit" with the last gate's note (or "").
 *
 * Gate sections are joined with "\n\n" in the order they were pushed,
 * so the push order shapes the note byte-for-byte.
 */
export function decideAudit(
	failures: string[],
	lastNote: string,
	results: AuditGateResults = {},
): AuditDecision {
	if (failures.length > 0) {
		const combinedNote = failures.join("\n\n");
		return {
			nextStatus: "Implementation",
			note: `The following gates blocked the transition from Implementation to Audit:\n\n${combinedNote}`,
			...results,
		};
	}

	// All gates passed — proceed to Audit
	return {
		nextStatus: "Audit",
		note: lastNote || "",
		...results,
	};
}
