// ─── File Classification ──────────────────────────────────────────
// Shared utilities for classifying files as test/source, extracted
// from the former tdd-gate.ts. Used by requirements-traceability.ts.

import { extname, basename } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────

/** Known test file extensions. */
const TEST_EXTENSIONS = new Set([".test.ts", ".test.mts", ".spec.ts"]);

/** Known test file name patterns (basename-based). */
const TEST_NAME_PATTERNS = [/^test_.+\.py$/i, /.+_test\.go$/i];

/**
 * Known source extensions for testable files.
 * Used by both isTestFile and isTestableFile.
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
 * Check whether a file path is a test file.
 *
 * Classification rules:
 * - Files with test extensions: .test.ts, .test.mts, .spec.ts
 * - Files with test name patterns: test_*.py, *_test.go
 * - Files inside __tests__/ directories
 */
export function isTestFile(filePath: string): boolean {
	if (!filePath || filePath.trim() === "") return false;

	// Check if inside __tests__ directory
	if (filePath.includes("/__tests__/") || filePath.startsWith("__tests__/")) {
		return true;
	}

	// Check by extension
	const baseWithExt = basename(filePath);

	// .test.ts, .test.mts, .spec.ts
	for (const testExt of TEST_EXTENSIONS) {
		if (baseWithExt.endsWith(testExt)) {
			const prefix = baseWithExt.slice(0, -testExt.length);
			if (prefix.length > 0) {
				return true;
			}
		}
	}

	// test_*.py pattern
	if (/^test_.+\.py$/i.test(baseWithExt)) {
		return true;
	}

	// *_test.go pattern
	if (/.+_test\.go$/i.test(baseWithExt)) {
		return true;
	}

	return false;
}

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

/**
 * Classify a list of changed files into test files and implementation files.
 */
export function classifyChangedFiles(files: string[]): {
	testFiles: string[];
	implFiles: string[];
} {
	const testFiles: string[] = [];
	const implFiles: string[] = [];

	for (const file of files) {
		if (isTestFile(file)) {
			testFiles.push(file);
		} else {
			const ext = extname(file);
			if (ext && SOURCE_EXTENSIONS.has(ext)) {
				implFiles.push(file);
			}
		}
	}

	return { testFiles, implFiles };
}
