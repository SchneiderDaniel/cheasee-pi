// ─── Agent Output Validation ────────────────────────────────────
// Schema validation for parsed agent output. Leaf module — must never
// import from output.ts (ESM cycle risk); output.ts imports from here.
// One artifact kind per group (issue #2033 split): `auditScore` lives in
// validation-score.ts, `findings` in validation-findings.ts, the shared
// severity enum in validation-shared.ts.

import { VALID_SEVERITIES, type ValidationResult } from "./validation-shared.ts";
import { validateFindings } from "./validation-findings.ts";
import { validateOptionalStrings } from "./validation-optional.ts";
import { validateAuditScore } from "./validation-score.ts";

/** Optional string fields pushed before the nested artifact kinds. */
const LEADING_STRING_FIELDS = ["commentBody", "prTitle", "prBody", "summary"] as const;

function validateAgentOutput(data: Record<string, unknown>): ValidationResult {
	const errors: string[] = [];

	// action is required and must be a valid enum value
	if (data.action === undefined || data.action === null) {
		errors.push("Missing required field: 'action'");
	} else if (typeof data.action !== "string") {
		errors.push("'action' must be a string");
	} else if (!["COMPLETE", "APPROVED", "REJECTED"].includes(data.action)) {
		errors.push(`'action' must be one of: COMPLETE, APPROVED, REJECTED (got: ${data.action})`);
	}

	// agentName is required and must be a string
	if (data.agentName === undefined || data.agentName === null) {
		errors.push("Missing required field: 'agentName'");
	} else if (typeof data.agentName !== "string") {
		errors.push("'agentName' must be a string");
	}

	// commentBody, prTitle, prBody, summary (optional, must be string if present)
	validateOptionalStrings(data, LEADING_STRING_FIELDS, errors);

	// auditScore validation — nested checks live in validateAuditScore
	validateAuditScore(data.auditScore, errors);

	// findings validation — nested checks live in validateFindings/validateFinding
	validateFindings(data.findings, errors);

	// targetStatus (optional, must be string if present) — pushed last
	validateOptionalStrings(data, ["targetStatus"], errors);

	return { valid: errors.length === 0, errors };
}

export { validateAgentOutput, VALID_SEVERITIES };
