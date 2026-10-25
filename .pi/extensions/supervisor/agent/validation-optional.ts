// ─── Agent Output Validation: optional string fields ────────────
// The "must be a string if provided" artifact kind (issue #2033 split): one
// generic check replaces the per-field copies, so the field list reads as data.
// Mutates the shared errors array in field order.

export function validateOptionalStrings(
	data: Record<string, unknown>,
	fields: readonly string[],
	errors: string[],
): void {
	for (const field of fields) {
		const value = data[field];
		if (value !== undefined && value !== null && typeof value !== "string") {
			errors.push(`'${field}' must be a string if provided`);
		}
	}
}
