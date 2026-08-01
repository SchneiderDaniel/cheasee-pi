// ─── Requirements Traceability — Test File Parity ─────────────────
// Checks that each changed source file has a corresponding test file
// via real file-system probes (existsSync). No exec interaction.

import { existsSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";

import { isTestableFile } from "../file-classification.ts";
import type { TraceabilityGap } from "./types.ts";

/**
 * Check that each changed source file has a corresponding test file.
 *
 * For each changed file that is testable (source code, not generated/vendor/barrel),
 * checks if a corresponding test file exists under test/ or tests/ directory.
 *
 * Mapping rules:
 * - src/foo.ts → test/foo.test.ts or tests/foo.test.ts
 * - src/foo.ts → test/foo.spec.ts or tests/foo.spec.ts
 * - src/sub/foo.ts → test/sub/foo.test.ts or tests/sub/foo.test.ts
 *
 * @param changedFiles - List of changed file paths
 * @param worktreePath - Path to worktree
 * @returns Array of gaps (one per missing test file)
 */
export async function checkTestFileParity(
	changedFiles: string[],
	worktreePath: string,
): Promise<TraceabilityGap[]> {
	if (changedFiles.length === 0) return [];

	const gaps: TraceabilityGap[] = [];

	for (const file of changedFiles) {
		// Skip non-testable files (type declarations, generated, vendor, barrel)
		if (!isTestableFile(file)) continue;

		// Skip test files themselves
		if (file.includes(".test.") || file.includes(".spec.") || file.includes("__tests__/")) {
			continue;
		}

		// Derive expected test file paths
		const dir = dirname(file);
		const baseName = basename(file);
		const ext = extname(baseName);
		const nameWithoutExt = baseName.slice(0, -ext.length);

		// Try test/ and tests/ directories
		const testDirs = ["test", "tests"];
		const possibleTestFiles: string[] = [];

		for (const testDir of testDirs) {
			// Determine the relative subdirectory under test/
			// src/foo.ts → test/foo.test.ts (no subdir)
			// src/sub/foo.ts → test/sub/foo.test.ts (subdir preserved)
			// lib/foo.ts → test/lib/foo.test.ts (non-src dir preserved)
			let testSubDir = dir;
			// Strip leading "src" or "src/" prefix to mirror under test/
			if (testSubDir === "src") {
				testSubDir = "";
			} else if (testSubDir.startsWith("src/")) {
				testSubDir = testSubDir.slice(4);
			}
			const testRelDir = testSubDir ? testSubDir + "/" : "";

			possibleTestFiles.push(
				join(testDir, testRelDir, `${nameWithoutExt}.test.ts`),
				join(testDir, testRelDir, `${nameWithoutExt}.test.mts`),
				join(testDir, testRelDir, `${nameWithoutExt}.spec.ts`),
			);

			// Also check src-relative: src/foo.ts → test/foo.ts (directory mirror)
			possibleTestFiles.push(join(testDir, file.replace(/^src\//, "")));
		}

		// Check if any test file exists
		const testExists = possibleTestFiles.some((tf) => existsSync(join(worktreePath, tf)));

		if (!testExists) {
			gaps.push({
				check: "test-file-parity",
				severity: "warning",
				detail: `Source file "${file}" has no corresponding test file. Expected one of: ${possibleTestFiles.slice(0, 4).join(", ")}`,
			});
		}
	}

	return gaps;
}
