import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Exec function type for subprocess calls (3-field return — code, stdout, stderr) */
type ExecFn = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

// ─── Package Safety Check ──────────────────────────────────────────
// Deterministic package age validation for npm install safety.
// Extracted from LLM-instructed agent prompts into stable TypeScript code.
//
// The 14-day safety threshold protects against typosquatting and
// dependency confusion attacks by blocking packages published less
// than 14 days ago.

/** Safety threshold in days — packages younger than this are blocked. */
export const SAFETY_THRESHOLD_DAYS = 14;

/** Result of a package age check. */
export interface PackageAgeResult {
	/** Whether the package is safe to install. */
	safe: boolean;
	/** Age of the package in whole days. */
	ageDays: number;
	/** Whether the package should be blocked (equivalent to !safe). */
	blocked: boolean;
}

/**
 * Parse a date string into a Date object.
 * Returns null for unparseable/null/undefined/empty inputs.
 */
function parseDate(dateStr: string | null | undefined): Date | null {
	if (dateStr === null || dateStr === undefined || dateStr === "") return null;
	const date = new Date(dateStr);
	if (isNaN(date.getTime())) return null;
	return date;
}

/**
 * Calculate the age in whole days between a date and now.
 */
function daysSince(date: Date): number {
	const now = Date.now();
	const diffMs = now - date.getTime();
	return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Check whether a package specifier is exempt from age checking.
 * Exempt: git URLs, tarballs, local paths.
 */
function isExempt(packageSpecifier: string): boolean {
	// git URL patterns
	if (
		packageSpecifier.startsWith("git+") ||
		packageSpecifier.startsWith("git:") ||
		packageSpecifier.startsWith("git@") ||
		packageSpecifier.startsWith("ssh:")
	) {
		return true;
	}

	// URL-based packages (tarballs, hosted packages)
	if (
		packageSpecifier.startsWith("http://") ||
		packageSpecifier.startsWith("https://") ||
		packageSpecifier.startsWith("file:")
	) {
		return true;
	}

	// Local paths (starting with ./, ../, or /)
	if (
		packageSpecifier.startsWith("./") ||
		packageSpecifier.startsWith("../") ||
		packageSpecifier.startsWith("/")
	) {
		return true;
	}

	return false;
}

/**
 * Build a blocked message for a package that failed the age check.
 */
function buildBlockedMessage(packageName: string, ageDays: number): string {
	return `Package ${packageName} is ${ageDays} days old — below ${SAFETY_THRESHOLD_DAYS}-day safety threshold. Cannot install.`;
}

/**
 * Calculate whether a package is safe based on its creation date.
 * Fail-closed: invalid/missing date → blocked.
 */
function calculate(createdDate: string | null | undefined): PackageAgeResult {
	const date = parseDate(createdDate);
	if (date === null) {
		// Fail closed: unparseable date → blocked
		return { safe: false, ageDays: 0, blocked: true };
	}

	const age = daysSince(date);
	if (age < SAFETY_THRESHOLD_DAYS) {
		return { safe: false, ageDays: age, blocked: true };
	}

	return { safe: true, ageDays: age, blocked: false };
}

/**
 * Package safety check with all methods exposed for testing and composition.
 */
export const checkPackageAge = {
	parseDate,
	daysSince,
	isExempt,
	calculate,
	buildBlockedMessage,
};

/**
 * Run a full package safety check from an npm view time.created string.
 * This is the main entry point for agent use.
 *
 * Steps:
 * 1. Check if package specifier is exempt (git URL, tarball, local path)
 * 2. Parse the date string from `npm view <pkg> time.created`
 * 3. Calculate age and determine safety
 *
 * @param packageName - The npm package name or specifier
 * @param createdDate - The result of `npm view <pkg> time.created` (ISO date string)
 * @returns PackageAgeResult with safe/blocked status
 */
export function runPackageSafetyCheck(
	packageName: string,
	createdDate: string | null | undefined,
): PackageAgeResult {
	// Exempt packages bypass the age check
	if (isExempt(packageName)) {
		return { safe: true, ageDays: 0, blocked: false };
	}

	return calculate(createdDate);
}

// ─── Audit-level types ────────────────────────────────────────────

/** Result of checking a single package during audit. */
export interface PackageAuditItem {
	/** The package name as it appears in package.json */
	packageName: string;
	/** Age of the package in whole days (0 if exempt or check failed) */
	ageDays: number;
	/** Whether the package passed the safety check */
	safe: boolean;
	/** Whether the package is blocked (equivalent to !safe) */
	blocked: boolean;
	/** Human-readable message explaining the result */
	message: string;
}

/** Result of a full package safety audit on a project. */
export interface PackageSafetyAuditResult {
	/** Overall status: "safe" if all pass, "blocked" if any fail, "error" if config error */
	status: "safe" | "blocked" | "error";
	/** Results for each dependency checked */
	results: PackageAuditItem[];
	/** Optional error message when status is "error" */
	message?: string;
}

// ─── runPackageSafetyAudit ─────────────────────────────────────────

/**
 * Run a full package safety audit on a project's dependencies.
 *
 * Reads the project's package.json, iterates over all dependencies
 * (and devDependencies), runs `npm view <pkg> time.created` for each
 * non-exempt package, and returns a structured result.
 *
 * @param exec - Exec function for running npm view
 * @param worktreePath - Path to the project worktree
 * @param packageJsonContent - Optional inline JSON (for testing, bypasses filesystem read)
 * @returns PackageSafetyAuditResult
 */
export async function runPackageSafetyAudit(
	exec: ExecFn,
	worktreePath: string,
	packageJsonContent?: string,
): Promise<PackageSafetyAuditResult> {
	let pkgJson: Record<string, unknown>;

	if (packageJsonContent !== undefined) {
		// Use provided content (test mode)
		try {
			pkgJson = JSON.parse(packageJsonContent) as Record<string, unknown>;
		} catch {
			return { status: "error", results: [], message: "Malformed package.json" };
		}
	} else {
		// Read from worktree filesystem
		try {
			const content = await readFile(join(worktreePath, "package.json"), "utf-8");
			pkgJson = JSON.parse(content) as Record<string, unknown>;
		} catch (err: unknown) {
			// No package.json → safe (nothing to check)
			if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
				return { status: "safe", results: [] };
			}
			// JSON parse error or other read error
			if (err instanceof SyntaxError) {
				return { status: "error", results: [], message: "Malformed package.json" };
			}
			return {
				status: "error",
				results: [],
				message: `Failed to read package.json: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	// Collect all dependencies and devDependencies
	const deps: Record<string, string> = {};
	if (
		typeof pkgJson.dependencies === "object" &&
		pkgJson.dependencies !== null &&
		!Array.isArray(pkgJson.dependencies)
	) {
		for (const [name, spec] of Object.entries(pkgJson.dependencies as Record<string, unknown>)) {
			if (typeof spec === "string") {
				deps[name] = spec;
			}
		}
	}
	if (
		typeof pkgJson.devDependencies === "object" &&
		pkgJson.devDependencies !== null &&
		!Array.isArray(pkgJson.devDependencies)
	) {
		for (const [name, spec] of Object.entries(pkgJson.devDependencies as Record<string, unknown>)) {
			if (typeof spec === "string") {
				deps[name] = spec;
			}
		}
	}

	const depEntries = Object.entries(deps);
	if (depEntries.length === 0) {
		return { status: "safe", results: [] };
	}

	const results: PackageAuditItem[] = [];
	let anyBlocked = false;

	for (const [packageName, packageSpecifier] of depEntries) {
		// Check if exempt (git URL, tarball, local path)
		if (isExempt(packageSpecifier)) {
			results.push({
				packageName,
				ageDays: 0,
				safe: true,
				blocked: false,
				message: "Exempt from age check (git URL, tarball, or local path)",
			});
			continue;
		}

		// Run npm view <pkg> time.created
		let createdDate: string | null = null;
		try {
			const npmResult = await exec("npm", ["view", packageName, "time.created"], {
				timeout: 15_000,
			});
			if (npmResult.code !== 0 || !npmResult.stdout || npmResult.stdout.trim() === "") {
				// Fail closed: non-zero exit or empty output → blocked
				results.push({
					packageName,
					ageDays: 0,
					safe: false,
					blocked: true,
					message: `Package ${packageName}: npm view failed or returned empty result. Cannot verify age.`,
				});
				anyBlocked = true;
				continue;
			}
			createdDate = npmResult.stdout.trim();
		} catch (err: unknown) {
			// Fail closed on error (ENOENT, etc.)
			results.push({
				packageName,
				ageDays: 0,
				safe: false,
				blocked: true,
				message: `Package ${packageName}: npm view failed (${err instanceof Error ? err.message : String(err)}). Cannot verify age.`,
			});
			anyBlocked = true;
			continue;
		}

		// Calculate age and determine safety
		const ageResult = runPackageSafetyCheck(packageName, createdDate);
		const item: PackageAuditItem = {
			packageName,
			ageDays: ageResult.ageDays,
			safe: ageResult.safe,
			blocked: ageResult.blocked,
			message: ageResult.blocked
				? buildBlockedMessage(packageName, ageResult.ageDays)
				: `Package ${packageName} is ${ageResult.ageDays} days old — safe.`,
		};
		results.push(item);
		if (!ageResult.safe) {
			anyBlocked = true;
		}
	}

	return {
		status: anyBlocked ? "blocked" : "safe",
		results,
	};
}
