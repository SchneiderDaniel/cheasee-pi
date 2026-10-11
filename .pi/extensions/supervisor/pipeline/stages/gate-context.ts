// ─── Gate Failure Context ─────────────────────────────────────────
// Split out of stages/core.ts (issue #2001); re-exported from there.

import type { StageState } from "./core.ts";

// ─── Gate Failure Context ────────────────────────────────────────────

/**
 * Apply gate failure context to stage state based on next status.
 * When effectiveNextStatus is "Implementation", the gate failure note
 * is stored for injection into the developer task on the next iteration,
 * AND a concise run-numbered entry is pushed to gateFailureHistory for
 * PR body rendering.
 * When effectiveNextStatus is "Audit", stale context is cleared.
 * Non-Implementation/Audit statuses leave state unchanged.
 * Empty notes are treated as no-ops.
 *
 * The runNumber parameter (1-indexed loop iteration) is embedded in the
 * gateFailureHistory entry for PR body context (R2 requirement).
 * When note is non-empty and effectiveNextStatus is "Implementation",
 * the first gate name is extracted from the note (content between ---
 * markers) and a formatted entry is pushed.
 */
export function applyGateFailureContext(
	state: StageState,
	effectiveNextStatus: string,
	note: string,
	runNumber?: number,
): void {
	if (effectiveNextStatus === "Implementation" && note && note.trim().length > 0) {
		state.gateFailureContext = note;
		// Extract first gate name from note for concise PR body entry.
		// The note from audit.ts has sections with "--- Gate Name ---" headers.
		const gateName = extractFirstGateName(note);
		const runLabel = runNumber !== undefined ? `run ${runNumber}` : `?`;
		state.gateFailureHistory.push(`${gateName} gate failed on ${runLabel} — developer restarted`);
	} else if (effectiveNextStatus === "Audit") {
		state.gateFailureContext = undefined;
	}
	// Other statuses (e.g., "Done") — leave state unchanged
}

/**
 * Extract the first gate name from a combined gate failure note.
 * The note from audit.ts contains sections delimited by "--- Gate Name ---"
 * headers (e.g., "--- CI Gate ---", "--- TypeScript Checkpoint ---").
 * Returns the gate name if found, or "Pre-transition" as fallback.
 */
function extractFirstGateName(note: string): string {
	const gatePattern = /---\s*(.+?)\s*---/;
	const match = note.match(gatePattern);
	if (match && match[1]) {
		return match[1].trim();
	}
	return "Pre-transition";
}
