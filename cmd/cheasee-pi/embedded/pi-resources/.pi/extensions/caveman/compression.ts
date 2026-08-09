/**
 * Compression decision logic for caveman extension
 *
 * Pure functions that determine compression behavior based on
 * run mode and system prompt options. No side effects.
 */

import type { Level } from "./types.ts";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// ExtensionMode is defined locally since it's not re-exported from
// @earendil-works/pi-coding-agent main index. Mirrors the upstream type.
// ---------------------------------------------------------------------------

export type ExtensionMode = "tui" | "rpc" | "json" | "print";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompressionResult = { skip: true } | { skip: false; intensity: Exclude<Level, "off"> };

// ---------------------------------------------------------------------------
// Mode-adaptive compression
// ---------------------------------------------------------------------------

/**
 * Determine whether to skip compression or use which intensity based on
 * the current run mode.
 *
 * - "json": always skip — compression may mangle structured output
 * - "rpc":  always skip — programmatic consumers expect full output
 * - "print": apply compression normally (terminal output)
 * - "tui":   apply compression normally (terminal output)
 * - undefined: conservative fallback → apply compression (tui behavior)
 */
export function resolveCompression(
	level: Level,
	mode: ExtensionMode | undefined,
): CompressionResult {
	if (level === "off") return { skip: true };

	// In JSON and RPC modes, skip compression to avoid mangling
	// structured output expected by programmatic consumers.
	if (mode === "json" || mode === "rpc") return { skip: true };

	// Print and TUI modes — apply compression at the given level
	// Undefined mode also defaults to applying compression (conservative)
	return { skip: false, intensity: level };
}

// ---------------------------------------------------------------------------
// System prompt options inspection
// ---------------------------------------------------------------------------

/**
 * Tools whose presence suggests lighter compression to preserve
 * structured output.
 */
const STRUCTURED_TOOLS = new Set(["ripgrep_search", "structural_search"]);

/**
 * Check whether the current system prompt options suggest that
 * compression should be lightened.
 *
 * Returns true when selectedTools includes tools like ripgrep_search
 * or structural_search that benefit from lighter compression.
 */
export function shouldLightenCompression(
	options: BuildSystemPromptOptions | undefined | null,
): boolean {
	if (!options) return false;

	const tools = options.selectedTools;
	if (!tools || tools.length === 0) return false;

	return tools.some((t) => STRUCTURED_TOOLS.has(t));
}
