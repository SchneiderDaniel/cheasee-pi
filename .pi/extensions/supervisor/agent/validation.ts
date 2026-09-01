// ─── Agent Output Validation ────────────────────────────────────
// Schema validation for parsed agent output. Leaf module — must never
// import from output.ts (ESM cycle risk); output.ts imports from here.

import type { FindingSeverity } from "../config/types.ts";

const VALID_SEVERITIES = new Set<FindingSeverity>(["critical", "warning", "suggestion"]);

interface ValidationResult {
	valid: boolean;
	errors: string[];
}

// ─── Nested validation helpers (extracted from validateAgentOutput, #1548) ──
// Each helper owns one nested block, flattened to guard clauses (≤2 control-
// flow nesting levels). They mutate the shared errors array in call order so
// push order across fields is preserved byte-for-byte.

function validateAuditScore(value: unknown, errors: string[]): void {
	// absent/null auditScore passes
	if (value === undefined || value === null) {
		return;
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		errors.push("'auditScore' must be an object with 'passing' and 'total' fields");
		return;
	}
	const score = value as Record<string, unknown>;
	if (typeof score.passing !== "number" || typeof score.total !== "number") {
		errors.push("'auditScore.passing' and 'auditScore.total' must be numbers");
		return;
	}
	// Two independent ifs, never else-if: negative inputs where passing > total
	// must push BOTH errors (verified pre-refactor behavior).
	if (score.passing < 0 || score.total < 0) {
		errors.push("'auditScore.passing' and 'auditScore.total' must be non-negative");
	}
	if (score.passing > score.total) {
		errors.push(
			`'auditScore.passing' (${score.passing}) cannot exceed 'auditScore.total' (${score.total})`,
		);
	}
}

function validateFinding(item: unknown, index: number, errors: string[]): void {
	if (typeof item !== "object" || item === null) {
		errors.push(`findings[${index}] must be an object`);
		return; // maps the loop `continue` — skip this entry's remaining field checks
	}
	const finding = item as Record<string, unknown>;

	// severity
	if (
		typeof finding.severity !== "string" ||
		!VALID_SEVERITIES.has(finding.severity as FindingSeverity)
	) {
		errors.push(
			`findings[${index}].severity must be one of: ${Array.from(VALID_SEVERITIES).join(", ")}`,
		);
	}

	// dimension
	if (typeof finding.dimension !== "string") {
		errors.push(`findings[${index}].dimension must be a string`);
	}

	// symptom, consequence, remedy are required strings
	if (typeof finding.symptom !== "string" || finding.symptom.trim() === "") {
		errors.push(`findings[${index}].symptom is required and must be a non-empty string`);
	}
	if (typeof finding.consequence !== "string" || finding.consequence.trim() === "") {
		errors.push(`findings[${index}].consequence is required and must be a non-empty string`);
	}
	if (typeof finding.remedy !== "string" || finding.remedy.trim() === "") {
		errors.push(`findings[${index}].remedy is required and must be a non-empty string`);
	}

	// location (optional)
	if (
		finding.location !== undefined &&
		finding.location !== null &&
		typeof finding.location !== "string"
	) {
		errors.push(`findings[${index}].location must be a string if provided`);
	}
}

function validateFindings(value: unknown, errors: string[]): void {
	// absent/null findings passes
	if (value === undefined || value === null) {
		return;
	}
	if (!Array.isArray(value)) {
		errors.push("'findings' must be an array if provided");
		return;
	}
	for (let i = 0; i < value.length; i++) {
		validateFinding(value[i], i, errors);
	}
}

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

	// refusal — if present, treat as rejection
	if (data.refusal !== undefined && data.refusal !== null) {
		if (typeof data.refusal === "string" && data.refusal.trim().length > 0) {
			errors.push(`Agent refused: ${data.refusal}`);
		}
	}

	// commentBody (optional, must be string if present)
	if (
		data.commentBody !== undefined &&
		data.commentBody !== null &&
		typeof data.commentBody !== "string"
	) {
		errors.push("'commentBody' must be a string if provided");
	}

	// prTitle (optional, must be string if present)
	if (data.prTitle !== undefined && data.prTitle !== null && typeof data.prTitle !== "string") {
		errors.push("'prTitle' must be a string if provided");
	}

	// prBody (optional, must be string if present)
	if (data.prBody !== undefined && data.prBody !== null && typeof data.prBody !== "string") {
		errors.push("'prBody' must be a string if provided");
	}

	// summary (optional, must be string if present)
	if (data.summary !== undefined && data.summary !== null && typeof data.summary !== "string") {
		errors.push("'summary' must be a string if provided");
	}

	// auditScore validation — nested checks live in validateAuditScore
	validateAuditScore(data.auditScore, errors);

	// findings validation — nested checks live in validateFindings/validateFinding
	validateFindings(data.findings, errors);

	// targetStatus (optional, must be string if present)
	if (
		data.targetStatus !== undefined &&
		data.targetStatus !== null &&
		typeof data.targetStatus !== "string"
	) {
		errors.push("'targetStatus' must be a string if provided");
	}

	return { valid: errors.length === 0, errors };
}

export { validateAgentOutput, VALID_SEVERITIES };
