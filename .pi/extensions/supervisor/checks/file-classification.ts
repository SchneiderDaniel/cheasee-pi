// ─── File Classification ──────────────────────────────────────────
// Shared utilities for classifying files as test/source, extracted
// from the former tdd-gate.ts. Consumed by checks/requirements/parity.ts,
// re-exported via checks/requirements/index.ts.

// ─── Constants ──────────────────────────────────────────────────────

/**
 * Known source extensions for testable files.
 * Used by isTestableFile.
 */
const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".mjs",
	".py",
	".go",
	".rs",
	".java",
]);

// ─── Classification Functions ───────────────────────────────────────

/**
 * Check whether a source file is testable (should have a corresponding test file).
 *
 * A file is testable if:
 * - It has a recognized source extension (.ts, .tsx, .js, .jsx, .mts, .mjs, .py, .go, .rs, .java)
 * - It is NOT a type declaration (*.d.ts)
 * - It is NOT under generated/ or vendor/ directory
 * - It is NOT a barrel re-export (index.ts where index.js, index.mjs also apply)
 */
export function isTestableFile(filePath: string): boolean {
	if (!filePath || filePath.trim() === "") return false;

	// Check for type declarations first
	if (filePath.endsWith(".d.ts")) return false;

	// Check for generated/ or vendor/ directory exclusion
	if (filePath.includes("/generated/") || filePath.startsWith("generated/")) return false;
	if (filePath.includes("/vendor/") || filePath.startsWith("vendor/")) return false;

	// Check for barrel re-export (index files)
	const baseName = filePath.split("/").pop() || "";
	if (
		baseName === "index.ts" ||
		baseName === "index.js" ||
		baseName === "index.mjs" ||
		baseName === "index.mts"
	) {
		return false;
	}

	// Check if it's a recognized source extension
	const dotIdx = filePath.lastIndexOf(".");
	if (dotIdx === -1) return false;
	const extension = filePath.slice(dotIdx);
	// Handle .d.ts special case (already handled above)
	if (extension === ".ts" && filePath.endsWith(".d.ts")) return false;
	if (SOURCE_EXTENSIONS.has(extension)) return true;

	return false;
}
