// ─── Agent Output Validation: audit score ───────────────────────
// The `auditScore` artifact kind (issue #2033 split). Mutates the shared
// errors array in call order.

export function validateAuditScore(value: unknown, errors: string[]): void {
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
