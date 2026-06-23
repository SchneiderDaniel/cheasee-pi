// ─── Duplicate Code Detection Gate ────────────────────────────────
// Pre-audit gate that runs jscpd on the full worktree, then filters
// results to only flag clones where at least one location is in a
// changed file (from git diff <default-branch> --name-only).
//
// If jscpd is unavailable, gracefully degrades with status "no_jscpd".
// The auditor agent then uses ripgrep_search / structural_search as fallback.

/** Exec function type for subprocess calls (3-field return — code, stdout, stderr) */
export type ExecFn = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

import { getChangedFilesFromGitDiff, isExecutableNotFound } from "./shared.ts";

// ─── Types ──────────────────────────────────────────────────────────

interface CloneLocation {
	file: string;
	startLine: number;
	endLine: number;
}

export interface NormalizedClone {
	type: "exact" | "renamed" | "near-miss";
	lines: number;
	similarity: number;
	locations: CloneLocation[];
}

export interface DuplicateCodeResult {
	status: "clean" | "duplicates_found" | "error" | "no_jscpd";
	clones: NormalizedClone[];
	totalDuplicateLines: number;
	changedFilesScanned: string[];
	/** Optional error message when status is "error" */
	message?: string;
}

// ─── jscpd Output Types ────────────────────────────────────────────

/** A fragment from jscpd output — represents one location of a clone. */
interface JscpdFragment {
	fragment: string;
	file: string;
	start: number;
	end: number;
}

/** A single clone entry from jscpd duplications array. */
export interface JscpdClone {
	id?: string;
	format: string;
	lines: number;
	tokens: number;
	type: number;
	fragments: JscpdFragment[];
}

/** Top-level jscpd JSON output structure. */
export interface JscpdOutput {
	statistics?: {
		total?: {
			clones: number;
			duplicatedLines: number;
			percentage: number;
		};
	};
	duplications?: JscpdClone[];
}

// ─── Pure Functions ─────────────────────────────────────────────────

/**
 * Map jscpd type number to string label.
 * jscpd types: 1 = exact, 2 = renamed, 3 = near-miss.
 * Unknown types gracefully default to "near-miss".
 */
export function mapJscpdType(type: number): NormalizedClone["type"] {
	if (type === 1) return "exact";
	if (type === 2) return "renamed";
	return "near-miss";
}

/**
 * Normalize a jscpd clone into our internal format.
 */
function normalizeClone(clone: JscpdClone): NormalizedClone {
	const locations: CloneLocation[] = clone.fragments.map((frag) => ({
		file: frag.file,
		startLine: frag.start,
		endLine: frag.end,
	}));

	// jscpd similarity is implicitly 100 for type=1, or we can compute
	// from the ratio. For simplicity, use:
	// - type 1 → 100
	// - type 2 → 90
	// - type 3 → 70
	const similarity = clone.type === 1 ? 100 : clone.type === 2 ? 90 : 70;

	return {
		type: mapJscpdType(clone.type),
		lines: clone.lines,
		similarity,
		locations,
	};
}

/** Extract file paths from a jscpd clone's fragments. */
function cloneFiles(clone: JscpdClone): string[] {
	return (clone.fragments || []).map((f) => f.file);
}

/**
 * Extract file paths from a jscpd clone's fragments.
 */
function cloneFiles(clone: JscpdClone): string[] {
	return clone.fragments.map((frag) => frag.file);
}

/**
 * Filter jscpd clones to only those where at least one location
 * is in the changed files list.
 */
export function filterClonesToChangedFiles(
	clones: JscpdClone[],
	changedFiles: string[],
): NormalizedClone[] {
	if (clones.length === 0 || changedFiles.length === 0) return [];
	const changedSet = new Set(changedFiles);
	return clones
		.filter((c: JscpdClone) => cloneFiles(c).some((f: string) => changedSet.has(f)))
		.map(normalizeClone);
}

/**
 * Sum total duplicate lines across all normalized clones.
 * For each clone, adds (endLine - startLine + 1) for each of its locations.
 */
export function sumDuplicateLines(clones: NormalizedClone[]): number {
	return clones.reduce((sum, clone) => {
		let total = 0;
		for (const loc of clone.locations) {
			total += loc.endLine - loc.startLine + 1;
		}
		return sum + total;
	}, 0);
}

/**
 * Build a DuplicateCodeResult from filtered clones.
 */
export function buildResult(
	filteredClones: NormalizedClone[],
	changedFilesScanned: string[],
): DuplicateCodeResult {
	const totalDuplicateLines = sumDuplicateLines(filteredClones);

	if (filteredClones.length === 0) {
		return {
			status: "clean",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned,
		};
	}

	return {
		status: "duplicates_found",
		clones: filteredClones,
		totalDuplicateLines,
		changedFilesScanned,
	};
}

/**
 * Parse jscpd JSON output from stdout.
 * Returns parsed JscpdOutput or null if parsing fails.
 */
function parseJscpdOutput(stdout: string): JscpdOutput | null {
	if (!stdout || stdout.trim() === "") return null;
	try {
		const parsed = JSON.parse(stdout) as JscpdOutput;
		return parsed;
	} catch {
		return null;
	}
}

// ─── Main Orchestration ────────────────────────────────────────────

/**
 * Run duplicate code detection on the worktree.
 *
 * Steps:
 * 1. Get changed files via `git diff <defaultBranch> --name-only` from worktree
 * 2. Run jscpd on the full worktree
 * 3. Parse jscpd output and filter clones to those touching changed files
 * 4. Return result
 *
 * @param exec - Exec function (from pi.exec or mock)
 * @param worktreePath - Path to the worktree
 * @param defaultBranch - Default branch name (e.g. "main")
 * @returns DuplicateCodeResult
 */
export async function runDuplicateCheck(
	exec: ExecFn,
	worktreePath: string,
	defaultBranch: string,
): Promise<DuplicateCodeResult> {
	let changedFiles: string[] = [];

	// Step 1: Get changed files from git diff
	try {
		changedFiles = await getChangedFilesFromGitDiff(exec, worktreePath, defaultBranch);

		// No changed files → nothing to check
		if (changedFiles.length === 0) {
			return {
				status: "clean",
				clones: [],
				totalDuplicateLines: 0,
				changedFilesScanned: [],
			};
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned: [],
			message: `git diff failed: ${msg}`,
		};
	}

	// Step 2: Run jscpd on the full worktree
	let jscpdStdout: string;
	try {
		const jscpdResult = await exec("jscpd", [
			worktreePath,
			"--min-lines",
			"5",
			"--min-tokens",
			"50",
			"--output",
			"json",
			"--silent",
		]);
		if (jscpdResult.code !== 0 && !jscpdResult.stdout) {
			return {
				status: "error",
				clones: [],
				totalDuplicateLines: 0,
				changedFilesScanned: changedFiles,
				message: `jscpd failed: ${jscpdResult.stderr || "exit code " + jscpdResult.code}`,
			};
		}
		jscpdStdout = jscpdResult.stdout || "";
	} catch (err: unknown) {
		// ENOENT means jscpd not installed
		if (isExecutableNotFound(err)) {
			return {
				status: "no_jscpd",
				clones: [],
				totalDuplicateLines: 0,
				changedFilesScanned: changedFiles,
			};
		}
		const msg = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned: changedFiles,
			message: `jscpd execution error: ${msg}`,
		};
	}

	// Step 3: Parse jscpd output
	const parsed = parseJscpdOutput(jscpdStdout);
	if (!parsed) {
		return {
			status: "error",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned: changedFiles,
			message: "jscpd returned non-JSON output",
		};
	}

	const jscpdClones = parsed.duplications || [];
	if (jscpdClones.length === 0) {
		return {
			status: "clean",
			clones: [],
			totalDuplicateLines: 0,
			changedFilesScanned: changedFiles,
		};
	}

	// Step 4: Filter to only clones touching changed files
	const filteredClones = filterClonesToChangedFiles(jscpdClones, changedFiles);

	// Step 5: Build and return result
	return buildResult(filteredClones, changedFiles);
}
