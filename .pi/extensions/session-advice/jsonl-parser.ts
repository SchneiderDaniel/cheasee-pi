/**
 * jsonl-parser.ts — Parse .jsonl session file into SessionData
 *
 * Extracts usage from assistant messages and output size from toolResults.
 * Uses readFileSync (synchronous) — adequate for session files <500KB.
 *
 * Infrastructure layer: wraps node:fs, translates file format → SessionData.
 * No pi dependencies.
 */

import { readFileSync } from "node:fs";
import type { SessionData, SessionEntry } from "./types.ts";

/**
 * Parse a .jsonl session file into SessionData with token cost data.
 * Returns null for empty or whitespace-only files.
 */
export function parseJsonlFile(filepath: string): SessionData | null {
	const raw = readFileSync(filepath, "utf-8").trim();
	if (!raw) return null;

	const lines = raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	if (lines.length === 0) return null;

	const header = lines[0];
	const sessionId: string = header.id ?? "unknown";
	const timestamp: string = header.timestamp ?? "";

	const entries: SessionEntry[] = [];
	let turnIndex = -1;
	let pendingAssistantCost = 0;
	let pendingUsage: SessionEntry["usage"] = undefined;

	for (const rawEntry of lines) {
		const type = rawEntry.type;
		if (type === "session") continue;

		// Track assistant messages with usage before their tool calls
		if (type === "message" && rawEntry.message?.role === "assistant") {
			if (turnIndex < 0) turnIndex = 0;
			const usage = rawEntry.message?.usage;
			if (usage) {
				pendingAssistantCost = usage.totalTokens ?? 0;
				pendingUsage = {
					input: usage.input ?? 0,
					output: usage.output ?? 0,
					totalTokens: usage.totalTokens ?? 0,
					cost: usage.cost?.total ?? 0,
				};
			}

			const content = rawEntry.message?.content ?? [];
			for (const c of content) {
				if (c.type === "toolCall") {
					const args = c.arguments ?? {};
					const cmd = (args.command ?? "") as string;
					entries.push({
						type: "tool_use",
						toolName: c.name ?? "?",
						args,
						text: cmd,
						turnIndex,
						assistantCost: pendingAssistantCost || undefined,
						usage: pendingUsage,
					});
					// Reset so we don't double-count if multiple tool calls in one assistant msg
					pendingAssistantCost = 0;
					pendingUsage = undefined;
				}
			}
			continue;
		}

		// User message = new turn
		if (type === "message" && rawEntry.message?.role === "user") {
			turnIndex++;
			continue;
		}

		if (type === "message" && rawEntry.message?.role === "toolResult") {
			if (turnIndex < 0) turnIndex = 0;

			const content = rawEntry.message?.content ?? [];
			const textParts: string[] = [];
			for (const c of content) {
				if (c.type === "text") textParts.push(c.text ?? "");
			}
			const text = textParts.join("\n");
			const toolName = rawEntry.message?.toolName ?? "?";
			const isError = rawEntry.message?.isError ?? false;

			entries.push({
				type: "tool_result",
				toolName,
				isError,
				text,
				turnIndex,
				outputSize: text.length,
			});
		}
	}

	return { sessionId, timestamp, entries };
}
