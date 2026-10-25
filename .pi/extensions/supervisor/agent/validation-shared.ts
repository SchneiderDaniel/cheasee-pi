// ─── Agent Output Validation: shared vocabulary ─────────────────
// Leaf module. The severity enum and the result shape are read by every
// validation group; keeping them here avoids a cycle through `validation.ts`.

import type { FindingSeverity } from "../config/types.ts";

export const VALID_SEVERITIES = new Set<FindingSeverity>(["critical", "warning", "suggestion"]);

export interface ValidationResult {
	valid: boolean;
	errors: string[];
}
