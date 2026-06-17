/**
 * session-utils.ts — Shared entry-parsing utilities for session-logger
 *
 * Extracted from duplicate model_change/thinking_level_change parsing logic
 * in renderer.ts and stats.ts. Both modules handle these entry types with
 * identical field extraction and array push patterns; this module provides
 * the single source of truth for that logic.
 */

// ── Types ──

export interface ModelChange {
	time: string;
	model: string;
}

interface ThinkingChange {
	time: string;
	level: string;
}

// ── handleModelChanges ──

/**
 * Process an array of session JSONL entries, extracting `model_change` and
 * `thinking_level_change` entries and pushing the parsed data into the
 * caller-supplied arrays.
 *
 * Entries with a `type` other than `model_change` or `thinking_level_change`
 * are silently skipped.
 *
 * @param entries - Array of session JSONL entry objects.
 * @param modelChanges - Mutable array to receive parsed model change entries.
 * @param thinkingChanges - Mutable array to receive parsed thinking change entries.
 */
export function handleModelChanges(
	entries: readonly any[],
	modelChanges: ModelChange[],
	thinkingChanges: ThinkingChange[],
): void {
	for (const entry of entries) {
		if (entry.type === "model_change") {
			modelChanges.push({
				time: entry.timestamp,
				model: `${entry.provider}/${entry.modelId}`,
			});
		} else if (entry.type === "thinking_level_change") {
			thinkingChanges.push({
				time: entry.timestamp,
				level: entry.thinkingLevel,
			});
		}
	}
}
