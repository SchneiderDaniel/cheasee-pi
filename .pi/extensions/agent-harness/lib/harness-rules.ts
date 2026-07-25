/**
 * harness-rules.ts — Shared tool-call detection rules, constants, and helpers.
 *
 * Bash command classification lives in `bash-query.ts` (pure functions).
 * This module owns harness-specific rules: thresholds, tool metadata,
 * redirect messages, and retry/cache helpers.
 *
 * This module exports:
 *  - Constants: CACHE_TTL_TURNS, CASCADE_THRESHOLD, MULTI_VERB_TOOLS, TOOL_META, etc.
 *  - Types: ToolMeta
 *  - Helpers: buildRedirectMessage, getToolMeta, isRedundantRead, etc.
 *
 * Zero pi dependencies — domain layer only.
 */

// ── Constants ──

/** Code file extensions (lowercase). */
const CODE_EXTENSIONS = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".rs", ".go"]);

/** TTL for read cache: number of turns before a cached entry expires. */
export const CACHE_TTL_TURNS = 6;

/** Max consecutive same-tool calls before triggering cascade block. */
export const CASCADE_THRESHOLD = 8;

/**
 * Resolved harness rules — the merged result of default rules + project-local config.
 * Used by AgentHarness for tool metadata lookup and cascade threshold.
 */
export interface ResolvedHarnessRules {
	toolMeta: Record<string, ToolMeta>;
	cascadeThreshold: number;
}

/**
 * Factory: returns a fresh copy of the default resolved rules.
 * Creates a shallow copy of TOOL_META so callers can mutate without affecting the original.
 */
export function loadDefaultRules(): ResolvedHarnessRules {
	return {
		toolMeta: { ...TOOL_META },
		cascadeThreshold: CASCADE_THRESHOLD,
	};
}

/**
 * Redirect guidance for tool misuse — maps misused tool name to
 * the forbidden CLI verbs and the dedicated pi tool to use instead.
 *
 * Keep in sync with actual bash-query classification in ../bash-query.ts.
 */
export const REDIRECT_GUIDANCE: Record<string, { forbidden: string; tool: string }> = {
	read: {
		forbidden: "'cat', 'head', or 'tail' in bash",
		tool: "read",
	},
	ripgrep_search: {
		forbidden: "'grep' or 'rg' in bash",
		tool: "ripgrep_search",
	},
};

/**
 * Multi-verb CLIs where first 2 tokens form the sub-key
 * (e.g., "git status" vs "git diff").
 * Single-verb commands use only the first token.
 */
export const MULTI_VERB_TOOLS = new Set([
	"git",
	"npm",
	"yarn",
	"cargo",
	"go",
	"docker",
	"kubectl",
	"gh",
]);

/** Max errors tracked per tool before triggering retry block. */
export const MAX_ERRORS_PER_TOOL = 3;

// ── Types ──

/** Per-tool metadata for harness configuration. */
export interface ToolMeta {
	/** If true, tool is never blocked by any guard. */
	passThrough?: boolean;
	/** Consecutive-call threshold before cascade block (default 8). */
	cascadeThreshold?: number;
}

/**
 * Per-tool metadata replacing PASS_THROUGH_TOOLS Set.
 * Tools not listed default to passThrough=false, cascadeThreshold=8.
 */
export const TOOL_META: Record<string, ToolMeta> = {
	ask_user: { passThrough: true },
	structural_search: { passThrough: true },
	ripgrep_search: { passThrough: true },
	bash: { cascadeThreshold: CASCADE_THRESHOLD },
	web_crawl: { cascadeThreshold: 20 },
};

/**
 * Get tool meta with defaults for unlisted tools.
 */
export function getToolMeta(toolName: string): ToolMeta {
	return TOOL_META[toolName] ?? { passThrough: false, cascadeThreshold: CASCADE_THRESHOLD };
}

/**
 * Build a structured redirect message for the LLM.
 * Returns a [SYSTEM OVERRIDE] block with forbidden action and tool name.
 *
 * When `schemaExample` is provided, it is appended as an "Example call:" line.
 * Without it, no schema example line is included (default).
 *
 * @param toolName — the pi tool to redirect to
 * @param schemaExample — optional example call string (e.g., '{ "path": "/path/to/file" }')
 * @returns formatted redirect message, or "" for unknown tools
 */
export function buildRedirectMessage(toolName: string, schemaExample?: string): string {
	const guidance = REDIRECT_GUIDANCE[toolName];
	if (!guidance) return "";

	const lines = [
		`[SYSTEM OVERRIDE] Action Blocked. Do not use ${guidance.forbidden}.`,
		`You MUST use the dedicated '${guidance.tool}' tool.`,
	];

	if (schemaExample) {
		lines.push(`Example call: ${schemaExample}`);
	}

	return lines.join("\n");
}

/**
 * Determine if a tool should be blocked based on accumulated error count.
 * Blocks when 2+ errors accumulated (consecutive or not, within the 3-entry window).
 */
export function shouldBlockRetry(errorCount: number): boolean {
	return errorCount >= 2;
}

/**
 * Check if reading the same file path within TTL turns is a redundant read.
 * @param prevPath — previously read path
 * @param currentPath — current read path
 * @param turnDiff — absolute turn difference
 */
export function isRedundantRead(prevPath: string, currentPath: string, turnDiff: number): boolean {
	if (!prevPath || !currentPath) return false;
	if (prevPath !== currentPath) return false;
	return turnDiff < CACHE_TTL_TURNS;
}

/**
 * Check if a file path corresponds to a code file (has recognized extension).
 */
export function isCodeFilePath(path: string): boolean {
	if (!path) return false;
	const lower = path.toLowerCase();
	for (const ext of CODE_EXTENSIONS) {
		if (lower.endsWith(ext)) return true;
	}
	return false;
}


