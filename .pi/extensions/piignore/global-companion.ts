/**
 * piignore-trust-check — Global companion extension for piignore.
 *
 * Participates in project_trust events to warn about restrictive .piignore
 * patterns BEFORE trust is granted. This file is self-contained (no imports
 * from piignore) because it loads as a global extension before project-local
 * extensions are available.
 *
 * Install: copy to ~/.pi/agent/extensions/piignore-trust-check.ts
 *
 * Requirements: Pi v0.79.0+ (project_trust event)
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Pattern parsing (self-contained — same logic as piignore/index.ts)
// ---------------------------------------------------------------------------

interface Pattern {
	regex: RegExp;
	negate: boolean;
}

// ---------------------------------------------------------------------------
// Over-broad pattern detection
// ---------------------------------------------------------------------------

interface PatternWarning {
	category: "unanchored-dir" | "broad-file-glob" | "name-heuristic";
	patterns: string[];
}

/**
 * Generic directory names that are commonly non-essential and likely
 * over-broad when used as unanchored dir patterns (ending with /).
 * Not exhaustive — curated to avoid warning fatigue on legitimate
 * narrow dir ignores like `secrets/`, `docs/`, `src/`.
 */
const GENERIC_DIR_NAMES = new Set([
	"build",
	"dist",
	"tmp",
	"temp",
	"cache",
	"caches",
	"logs",
	"log",
	"old",
	"node_modules",
	"bower_components",
	"jspm_packages",
	"vendor",
	"target",
	"out",
	"output",
]);

/**
 * File extensions that are commonly non-essential (logs, caches,
 * archives, temp files). Warnings are only raised for these specific
 * extensions to avoid false positives on project-specific types.
 */
const NON_ESSENTIAL_EXTENSIONS = new Set([
	"log",
	"db",
	"sqlite",
	"sqlite3",
	"tar",
	"zip",
	"gz",
	"bz2",
	"7z",
	"rar",
	"bak",
	"tmp",
	"temp",
	"cache",
	"pid",
	"lock",
	"swp",
	"swo",
]);

/**
 * Sensitive keywords that, when used in name-heuristic patterns with
 * wildcard adjacency (e.g. `**​/*secret*`, `*token*`), suggest the
 * pattern is matching on name heuristics rather than exact paths.
 */
const SENSITIVE_KEYWORDS = [
	"secret",
	"token",
	"password",
	"credential",
	"cert",
	"private",
	"key",
	"auth",
];

/**
 * Human-readable labels for each over-broad pattern category.
 */
const CATEGORY_LABELS: Record<PatternWarning["category"], string> = {
	"unanchored-dir": "Unanchored generic directories",
	"broad-file-glob": "Broad file-type globs",
	"name-heuristic": "Name-heuristic patterns",
};

/**
 * Check if a raw .piignore line is a restrictive pattern that would
 * block most or all paths. These are patterns like `*`, `**`, `/`,
 * `/*`, `/**` that match broadly and may cause unexpected blocking.
 */
function isRestrictiveRaw(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return false;
	// Strip negation prefix to check the actual pattern
	const pattern = trimmed.startsWith("!") ? trimmed.slice(1).trim() : trimmed;
	return (
		pattern === "*" || pattern === "**" || pattern === "/" || pattern === "/*" || pattern === "/**"
	);
}

/**
 * Parse a .piignore file content and return raw non-empty, non-comment lines.
 * Used by the companion to scan for restrictive patterns.
 */
function parseIgnoreRaw(content: string): string[] {
	const lines: string[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		lines.push(trimmed);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Over-broad pattern detection
// ---------------------------------------------------------------------------

/**
 * Detect unanchored directory-only patterns that match generic dir names
 * at any depth (e.g. `build/`, `tmp/`, `node_modules/`).
 *
 * Returns true when:
 * - Pattern ends with /
 * - Has no leading / (root-anchored)
 * - Has no internal / (path-anchored)
 * - The directory name is in GENERIC_DIR_NAMES
 */
export function isUnanchoredDirPattern(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return false;
	// Strip negation prefix to check the actual pattern
	const pattern = trimmed.startsWith("!") ? trimmed.slice(1).trim() : trimmed;

	// Must end with /
	if (!pattern.endsWith("/")) return false;

	// Must NOT have leading / (root-anchored)
	if (pattern.startsWith("/")) return false;

	// Must NOT have internal / (path-anchored)
	const dirName = pattern.slice(0, -1); // remove trailing /
	if (dirName.includes("/")) return false;

	// Dir name must be in the generic set
	return GENERIC_DIR_NAMES.has(dirName);
}

/**
 * Detect broad file-type glob patterns that match all files of a
 * non-essential type project-wide (e.g. `*.log`, `**​/*.db`).
 *
 * Returns true when:
 * - Pattern matches `*.{ext}` or `**​/*.{ext}` where ext is in
 *   NON_ESSENTIAL_EXTENSIONS
 */
export function isBroadFileGlob(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return false;
	// Strip negation prefix to check the actual pattern
	const pattern = trimmed.startsWith("!") ? trimmed.slice(1).trim() : trimmed;

	// Match `*.{ext}` where ext is in NON_ESSENTIAL_EXTENSIONS
	const singleStar = /^\*\.([a-zA-Z][a-zA-Z0-9]*)$/.exec(pattern);
	if (singleStar && NON_ESSENTIAL_EXTENSIONS.has(singleStar[1])) {
		return true;
	}

	// Match `**​/*.{ext}` where ext is in NON_ESSENTIAL_EXTENSIONS
	const doubleStar = /^\*\*\/\*\.([a-zA-Z][a-zA-Z0-9]*)$/.exec(pattern);
	if (doubleStar && NON_ESSENTIAL_EXTENSIONS.has(doubleStar[1])) {
		return true;
	}

	return false;
}

/**
 * Detect name-heuristic patterns that match on sensitive keywords
 * with wildcard adjacency (e.g. `**​/*secret*`, `*token*`).
 *
 * Returns true when:
 * - Pattern contains a SENSITIVE_KEYWORDS term
 * - The keyword has `*` adjacent on at least one side (substring-heuristic)
 *
 * This avoids flagging literal filenames like `secrets/` or `secret.txt`
 * that happen to contain a keyword substring.
 */
export function isNameHeuristicPattern(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return false;
	// Strip negation prefix to check the actual pattern
	const pattern = trimmed.startsWith("!") ? trimmed.slice(1).trim() : trimmed;

	for (const keyword of SENSITIVE_KEYWORDS) {
		// Check for *adjacent-to-keyword patterns: *keyword*, *keyword, keyword*
		const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`\\*${escapedKeyword}|${escapedKeyword}\\*`);
		if (regex.test(pattern)) {
			return true;
		}
	}

	return false;
}

/**
 * Classify each line into zero or one overbroad category.
 * Returns deduplicated warnings grouped by category.
 */
export function detectOverbroadPatterns(lines: string[]): PatternWarning[] {
	const warnings: PatternWarning[] = [];

	const unanchoredDirs: string[] = [];
	const broadGlobs: string[] = [];
	const heuristicPatterns: string[] = [];

	for (const line of lines) {
		if (isRestrictiveRaw(line)) continue; // handled by existing check — not overbroad
		if (isUnanchoredDirPattern(line)) {
			unanchoredDirs.push(line);
		} else if (isBroadFileGlob(line)) {
			broadGlobs.push(line);
		} else if (isNameHeuristicPattern(line)) {
			heuristicPatterns.push(line);
		}
	}

	if (unanchoredDirs.length > 0) {
		warnings.push({ category: "unanchored-dir", patterns: unanchoredDirs });
	}
	if (broadGlobs.length > 0) {
		warnings.push({ category: "broad-file-glob", patterns: broadGlobs });
	}
	if (heuristicPatterns.length > 0) {
		warnings.push({ category: "name-heuristic", patterns: heuristicPatterns });
	}

	return warnings;
}

/**
 * Format a list of PatternWarning into a concise, human-readable
 * notification message grouped by category. Returns empty string
 * when there are no warnings (signals no notification needed).
 */
export function buildWarningMessage(warnings: PatternWarning[]): string {
	if (warnings.length === 0) return "";

	const parts: string[] = [];
	for (const warning of warnings) {
		parts.push(`  ${CATEGORY_LABELS[warning.category]}: ${warning.patterns.join(", ")}`);
	}

	return `\u26a0\ufe0f piignore: .piignore contains over-broad patterns:\n${parts.join("\n")}. Review before granting trust.`;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * piignore-trust-check extension.
 *
 * Registers a project_trust handler that:
 * - Scans the project's .piignore for restrictive patterns
 * - Warns the user if restrictive patterns are found
 * - Always returns { trusted: "undecided" } — does NOT make trust decisions
 * - Never throws (all errors caught internally)
 */
export default function (pi: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}): void {
	pi.on("project_trust", (_event: unknown, ctx: unknown) => {
		try {
			const extCtx = ctx as {
				cwd?: string;
				hasUI?: boolean;
				ui?: { notify: (message: string, type: string) => void };
			};

			if (!extCtx.cwd) return { trusted: "undecided" as const };

			const ignorePath = path.join(extCtx.cwd, ".piignore");
			let content: string;
			try {
				content = fs.readFileSync(ignorePath, "utf-8");
			} catch {
				// No .piignore or can't read — not a concern
				return { trusted: "undecided" as const };
			}

			const lines = parseIgnoreRaw(content);
			const restrictivePatterns = lines.filter(isRestrictiveRaw);
			const overbroadWarnings = detectOverbroadPatterns(lines);

			// Build combined warning message
			const messageParts: string[] = [];
			if (restrictivePatterns.length > 0) {
				messageParts.push(
					`restrictive patterns (${restrictivePatterns.join(", ")}) that may block most files`,
				);
			}
			if (overbroadWarnings.length > 0) {
				const categoryLines = overbroadWarnings.map(
					(w) => `  ${CATEGORY_LABELS[w.category]}: ${w.patterns.join(", ")}`,
				);
				messageParts.push(`over-broad patterns:\n${categoryLines.join("\n")}`);
			}

			if (messageParts.length > 0 && extCtx.hasUI && extCtx.ui) {
				extCtx.ui.notify(
					`⚠️ piignore: .piignore contains ${messageParts.join(" and ")}. Review before granting trust.`,
					"warning",
				);
			}

			return { trusted: "undecided" as const };
		} catch {
			// Never crash — fail silently, return undecided
			return { trusted: "undecided" as const };
		}
	});
}
