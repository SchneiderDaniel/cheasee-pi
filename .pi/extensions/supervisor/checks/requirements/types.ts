// ─── Requirements Traceability — Shared Types ─────────────────────
// Shared contracts for the requirements traceability gate. Kept in
// their own module to break the type-only circular import between the
// orchestrator and its check modules.

/** A single traceability gap found by one of the deterministic checks. */
export interface TraceabilityGap {
	/** Check identifier (e.g. "checklist-keyword-coverage", "test-file-parity") */
	check: string;
	/** Severity: "info" for advisory, "warning" for likely issues */
	severity: "info" | "warning";
	/** Human-readable detail about the gap */
	detail: string;
}

/** A parsed checklist item from issue body. */
export interface ChecklistItem {
	text: string;
	checked: boolean;
}

/** Keywords extracted for a single checklist item. */
export interface ChecklistKeywords {
	item: string;
	keywords: string[];
}

/** Filtered issue data (body + trusted comments). */
export interface FilteredIssueData {
	body: string;
	comments: Array<{ author: string; body: string }>;
}
