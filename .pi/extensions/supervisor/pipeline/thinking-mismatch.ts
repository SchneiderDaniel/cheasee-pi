// ─── Thinking Level Mismatch Detection ────────────────────────────
// Reads a session JSONL file and compares the configured thinking level
// (from agent frontmatter) against the effective level recorded in the
// session file after pi's clampThinkingLevel() clamping.
//
// Session file format: JSONL with entries of various types.
// Thinking level is recorded as a "thinking_level_change" entry at session start.
// See: node_modules/@earendil-works/pi-coding-agent/docs/session-format.md

import { existsSync, readFileSync } from "node:fs";
import {
	parseSessionEntries,
	type ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────────

export interface ThinkingMismatch {
	/** Configured thinking level from agent frontmatter (e.g. "medium") */
	configured: string;
	/** Effective thinking level from session after clamping (e.g. "high") */
	effective: string;
}

// ─── Detection ─────────────────────────────────────────────────────

/**
 * Detect if the configured thinking level differs from the effective level
 * recorded in the session file after pi's clamping logic.
 *
 * Returns null (no mismatch) when:
 * - `sessionPath` is undefined or file doesn't exist
 * - `configuredLevel` is undefined or empty
 * - No `thinking_level_change` entry found in the session file
 * - Levels match (no clamping occurred)
 */
export function detectThinkingLevelMismatch(
	sessionPath: string | undefined,
	configuredLevel: string | undefined,
): ThinkingMismatch | null {
	if (!sessionPath || !configuredLevel || !existsSync(sessionPath)) {
		return null;
	}

	const content = readFileSync(sessionPath, "utf-8");
	if (!content.trim()) return null;

	const entries = parseSessionEntries(content);

	// Find the first thinking_level_change entry — this records the effective
	// level after clamping at session start, before any user messages.
	for (const entry of entries) {
		if (entry.type === "thinking_level_change") {
			const tlc = entry as ThinkingLevelChangeEntry;
			if (tlc.thinkingLevel && tlc.thinkingLevel !== configuredLevel) {
				return {
					configured: configuredLevel,
					effective: tlc.thinkingLevel,
				};
			}
			// Found the entry and levels match — no mismatch
			return null;
		}
	}

	return null;
}
