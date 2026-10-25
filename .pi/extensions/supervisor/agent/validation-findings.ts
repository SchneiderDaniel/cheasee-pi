// ─── Agent Output Validation: findings ──────────────────────────
// One artifact kind per module (issue #2033 split): the `findings` array and
// its entries. Helpers mutate the shared errors array in call order so push
// order across fields is preserved byte-for-byte.

import { VALID_SEVERITIES } from "./validation-shared.ts";

function validateFinding(item: unknown, index: number, errors: string[]): void {
	if (typeof item !== "object" || item === null) {
		errors.push(`findings[${index}] must be an object`);
		return; // maps the loop `continue` — skip this entry's remaining field checks
	}
	const finding = item as Record<string, unknown>;

	// severity
	if (
		typeof finding.severity !== "string" ||
		!VALID_SEVERITIES.has(finding.severity as "critical" | "warning" | "suggestion")
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

export function validateFindings(value: unknown, errors: string[]): void {
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
