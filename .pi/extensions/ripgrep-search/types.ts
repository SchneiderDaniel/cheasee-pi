/**
 * Shared types for ripgrep-search extension.
 *
 * These types are used across all modules in this package and exported
 * for use by the extension entry point and tests.
 */

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

/** Extension mode — mirrors upstream for mode gating in renderers. */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

/** Search configuration from .pi/settings.json. */
export interface SearchConfig {
	searchBackend: "auto" | "ripgrep" | "grep";
	maxLineLength: number;
}
