// ─── Session Replay ────────────────────────────────────────────────
// Reads a saved session JSONL file (from pi --mode json --session) and
// replays it as a persistent supervisor chat message via pi.sendMessage.
//
// Session file format: JSONL with per-line entries of type "message",
// "session", "compaction", etc. Only "message" entries are replayed.
// See: packages/coding-agent/docs/session-format.md
//
// The replay message is dispatched with eventType: "subagent-result"
// for rich rendering by session/message-renderer.ts.

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────────

interface SessionEntry {
	type: string;
	role?: string;
	id?: string;
	parentId?: string;
	content?: string | Array<{ type: string; text?: string; thinking?: string }>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
	toolName?: string;
	toolCallId?: string;
}

interface ReplayStats {
	turnCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

// ─── Replay ─────────────────────────────────────────────────────────

/**
 * Read a session JSONL file and emit a persistent supervisor chat message.
 *
 * @param sessionPath - Absolute path to the session JSONL file
 * @param pi - ExtensionAPI for sendMessage
 * @param agentName - Agent name for the replay message header
 * @param maxLines - Max lines of replay content (default 200, ~8KB)
 * @returns true if replay was emitted, false if skipped
 */
export async function replaySessionFile(
	sessionPath: string | undefined,
	pi: Pick<ExtensionAPI, "sendMessage">,
	agentName?: string,
	maxLines: number = 200,
): Promise<boolean> {
	if (!sessionPath || !existsSync(sessionPath)) return false;

	const content = readFileSync(sessionPath, "utf-8");
	const lines = content.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return false;

	// ── Parse JSONL entries ────────────────────────────────────
	const entries: SessionEntry[] = [];
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as SessionEntry;
			if (entry && typeof entry === "object") {
				entries.push(entry);
			}
		} catch {
			// Skip malformed JSON lines
		}
	}

	// ── Filter message entries and build replay text ────────────
	const messageEntries = entries.filter((e) => e.type === "message");
	if (messageEntries.length === 0) return false;

	const replayParts: string[] = [];
	const stats: ReplayStats = {
		turnCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};

	for (const msg of messageEntries) {
		// Track usage from assistant messages
		if (msg.role === "assistant" && msg.usage) {
			stats.turnCount++;
			if (typeof msg.usage.input === "number") stats.inputTokens = msg.usage.input;
			if (typeof msg.usage.output === "number") stats.outputTokens = msg.usage.output;
			if (typeof msg.usage.cacheRead === "number") stats.cacheRead = msg.usage.cacheRead;
			if (typeof msg.usage.cacheWrite === "number") stats.cacheWrite = msg.usage.cacheWrite;
			if (msg.usage.cost && typeof msg.usage.cost.total === "number") {
				stats.cost = msg.usage.cost.total;
			}
		}

		// Extract text content
		let text = "";
		if (typeof msg.content === "string") {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "text" && block.text) text += block.text + "\n";
				if (block.type === "thinking" && block.thinking) {
					const t =
						typeof block.thinking === "string" ? block.thinking : JSON.stringify(block.thinking);
					text += `💭 ${t}\n`;
				}
			}
		}

		if (text.trim()) {
			// Truncate very long individual messages
			const MAX_MSG_CHARS = 10_000;
			if (text.length > MAX_MSG_CHARS) {
				text =
					text.slice(0, MAX_MSG_CHARS) +
					`\n…[truncated: ${text.length - MAX_MSG_CHARS} more chars]`;
			}
			replayParts.push(text);
		}

		// Stop if we have enough lines
		if (replayParts.join("\n").split("\n").length > maxLines) break;
	}

	if (replayParts.length === 0) return false;

	const replayText = replayParts.join("\n\n").trim();

	// Build a stats summary for the content header
	const statsLines: string[] = [];
	if (stats.turnCount > 0)
		statsLines.push(`${stats.turnCount} turn${stats.turnCount !== 1 ? "s" : ""}`);
	if (stats.inputTokens > 0 || stats.outputTokens > 0) {
		statsLines.push(`↑${stats.inputTokens} ↓${stats.outputTokens} tokens`);
	}
	if (stats.cacheRead > 0) statsLines.push(`R${stats.cacheRead} cache`);
	if (stats.cacheWrite > 0) statsLines.push(`W${stats.cacheWrite} cache`);
	if (stats.cost > 0) statsLines.push(`$${stats.cost.toFixed(4)}`);

	const header = agentName
		? `📋 Replay: ${agentName} session${statsLines.length > 0 ? ` — ${statsLines.join(" · ")}` : ""}`
		: `📋 Replay${statsLines.length > 0 ? ` — ${statsLines.join(" · ")}` : ""}`;

	pi.sendMessage({
		customType: "supervisor",
		content: `${header}\n\n${replayText.slice(0, 8000)}`,
		display: true,
		details: {
			eventType: "subagent-result",
			content: [{ type: "text", text: replayText }],
			details: {
				agentName: agentName || "replay",
				success: true,
				statusLabel: "REPLAY",
				summaryLine: statsLines.join(" · "),
				model: "",
				inputTokens: stats.inputTokens,
				outputTokens: stats.outputTokens,
				cacheRead: stats.cacheRead,
				cacheWrite: stats.cacheWrite,
				cost: stats.cost,
				turnCount: stats.turnCount,
				durationMs: 0,
				toolCalls: [],
				toolResults: [],
				taskPrompt: "",
			},
		},
	});

	return true;
}
