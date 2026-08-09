/**
 * tool-schema-examples.ts — Manually-synchronized tool schema examples.
 *
 * ⚠️  MUST be updated when tool parameter schemas change.
 * This file is a manual-sync bridge — there is no compile-time link to the
 * canonical TypeBox schema definitions in pi-coding-agent or ripgrep-search.
 *
 * When a tool's parameter shape, optionality, or defaults change, update both
 * the example string AND this comment.
 *
 * Used by callers of `buildRedirectMessage(toolName, schemaExample)` who want
 * the "Example call:" line in redirect messages. The default is to omit it.
 *
 * Exports:
 *   getToolSchemaExample(toolName) — returns example string or undefined
 */

// ── Schema examples ──

const TOOL_SCHEMA_EXAMPLES: Record<string, string> = {
	/**
	 * read(path: string, offset?: number, limit?: number)
	 * - path: absolute or relative path to file
	 * - offset: 1-indexed line to start from (default 0)
	 * - limit: max lines to return (defaults to 2000 lines or 50KB truncation)
	 */
	read: '{ "path": "/path/to/file" }',

	/**
	 * ripgrep_search(query: string, directory?: string, max_count?: number)
	 * - query: search pattern (regex or literal)
	 * - directory: search root (default ".")
	 * - max_count: max results to return (default 10)
	 */
	ripgrep_search: '{ "query": "pattern", "directory?": ".", "max_count?": 10 }',
};

/**
 * Get a schema example string for a tool, for use in redirect messages.
 * Returns undefined for unknown tools (no example available).
 */
export function getToolSchemaExample(toolName: string): string | undefined {
	return TOOL_SCHEMA_EXAMPLES[toolName];
}
