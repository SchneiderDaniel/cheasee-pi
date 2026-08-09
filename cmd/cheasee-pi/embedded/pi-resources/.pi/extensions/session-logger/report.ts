/**
 * report.ts — Session report generation for session-logger
 *
 * Generates .md reports and .metadata.json files alongside .jsonl session files.
 * Extracted from index.ts for testability and separation of concerns.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { computeToolStats } from "./stats.ts";
import type { StatsSnapshot } from "./stats.ts";
import { ensureSymlink } from "./files.ts";
import { renderSessionToMarkdown, parseSessionStats } from "./renderer.ts";
import type { ParsedSessionStats } from "./renderer.ts";
import type { Metadata } from "./types.ts";

/**
 * Build a Metadata object from parsed session stats, optionally merging
 * in-memory timing data from a StatsSnapshot.
 *
 * When a snapshot is provided, call/error counts come from the parsed JSONL
 * (source of truth) while totalDurationMs is overwritten from the computed
 * in-memory stats (more accurate timing). Tools present in the snapshot but
 * missing from parsed are added with full stats from the computed snapshot.
 *
 * Pure function — no side effects, no file I/O.
 */
export function buildMetadata(
	parsed: ParsedSessionStats,
	snapshot?: StatsSnapshot,
	overrides?: { sessionName?: string; mode?: string },
): Metadata {
	// Build tool stats — prefer in-memory timing when snapshot is available.
	// Parsed stats are source of truth for call/error counts (message replay).
	// In-memory stats provide accurate totalDurationMs.
	let toolStats = parsed.toolStats;
	if (snapshot) {
		const computedStats = computeToolStats(snapshot.toolExecutions);
		const merged = { ...parsed.toolStats };
		for (const [toolName, stats] of Object.entries(computedStats)) {
			if (merged[toolName]) {
				// Keep parsed call/error counts, override duration from memory
				merged[toolName].totalDurationMs = stats.totalDurationMs;
			} else {
				// Tool exists in memory but not in JSONL — add it
				merged[toolName] = stats;
			}
		}
		toolStats = merged;
	}

	return {
		sessionId: parsed.sessionId,
		name: overrides?.sessionName ?? undefined,
		mode: overrides?.mode,
		messages: parsed.entryCount,
		tokens: parsed.tokens,
		cost: parsed.cost,
		compactions: parsed.compactions,
		modelChanges: parsed.modelChanges,
		thinkingChanges: parsed.thinkingChanges,
		perTurnTokens: parsed.perTurnTokens,
		toolStats,
		subagentToolStats: parsed.subagentToolStats,
		fileModifications: parsed.fileModifications,
	};
}

/**
 * Generate metadata.json and .md report for a session file if they're missing.
 * Called from session_shutdown (primary) and session_start (recovery).
 */
export async function generateMissingReports(
	sessionFilePath: string,
	snapshot?: StatsSnapshot,
	overrides?: { sessionName?: string; mode?: string },
): Promise<void> {
	// Check if the JSONL file still exists (might have been cleaned up)
	if (!fs.existsSync(sessionFilePath)) return;

	const sessionDir = path.dirname(sessionFilePath);
	const sessionPrefix = path.basename(sessionFilePath, ".jsonl");

	// Skip if both metadata and MD already exist
	const metaPath = path.join(sessionDir, `${sessionPrefix}.metadata.json`);
	const mdPath = path.join(sessionDir, `${sessionPrefix}.md`);
	if (fs.existsSync(metaPath) && fs.existsSync(mdPath)) return;

	// Parse stats from JSONL — source of truth
	let parsed: ParsedSessionStats | null = null;
	try {
		parsed = parseSessionStats(sessionFilePath);
	} catch (err) {
		console.error(`[session-logger] Failed to parse ${sessionFilePath}: ${(err as Error).message}`);
		return;
	}

	if (!parsed) return;

	const meta = buildMetadata(parsed, snapshot, overrides);

	// Write metadata if missing
	if (!fs.existsSync(metaPath)) {
		try {
			fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
			await ensureSymlink(sessionDir, metaPath, "latest.metadata.json");
		} catch (err) {
			console.error(`[session-logger] Failed to write metadata: ${(err as Error).message}`);
		}
	}

	// Generate .md report if missing
	if (!fs.existsSync(mdPath)) {
		try {
			const md = renderSessionToMarkdown(sessionFilePath, overrides);
			fs.writeFileSync(mdPath, md, "utf-8");
			await ensureSymlink(sessionDir, mdPath, "latest.md");
		} catch (err) {
			console.error(`[session-logger] Failed to write report: ${(err as Error).message}`);
		}
	}
}
