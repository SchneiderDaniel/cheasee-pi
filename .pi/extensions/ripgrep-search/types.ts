/**
 * Shared types for ripgrep-search extension.
 *
 * These types are used across all modules in this package and exported
 * for use by the extension entry point and tests.
 */

import { type Static, Type } from "typebox";

/** Single parsed vimgrep result entry. */
export interface RgMatch {
	file: string;
	line: number;
	column: number;
	text: string;
}

/** Shaped output for tool result. */
export interface RgResult {
	total_returned: number;
	results: RgMatch[];
	truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Output contract (structuredContent)
// ---------------------------------------------------------------------------

/**
 * JSON Schema of `ripgrep_search`'s `structuredContent`.
 *
 * One permissive object covers the success, no-match, and error paths:
 * `error`/`code` are optional and every other field is always present, so a
 * structured result conforms to this schema on every exit (MCP requires
 * structured results to match the declared output schema).
 *
 * Properties deliberately carry no `description` — described properties expand
 * the codemode declaration one line each and output schemas have no size cap.
 */
export const RipgrepSearchOutputSchema = Type.Object({
	query: Type.String(),
	searcher: Type.String(),
	directory: Type.String(),
	total_returned: Type.Number(),
	results: Type.Array(
		Type.Object({
			// one result entry, mirrors RgMatch
			file: Type.String(),
			line: Type.Number(),
			column: Type.Number(),
			text: Type.String(),
		}),
	),
	truncated: Type.Boolean(),
	error: Type.Optional(Type.String()),
	code: Type.Optional(Type.Number()),
});

/** Structured payload returned by `ripgrep_search` as `structuredContent`. */
export type RipgrepSearchOutput = Static<typeof RipgrepSearchOutputSchema>;

/** Extension mode — mirrors upstream for mode gating in renderers. */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

/** Search configuration from .pi/settings.json. */
export interface SearchConfig {
	searchBackend: "auto" | "ripgrep" | "grep";
	maxLineLength: number;
}
