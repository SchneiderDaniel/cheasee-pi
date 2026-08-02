/**
 * Markdown session report renderer.
 *
 * Reads any .pi/sessions/*.jsonl file and produces a human-readable .md report.
 * Pure function — no side effects, no extension dependencies.
 *
 * Public entry point. Orchestrates six section builders and re-exports the
 * metadata-side stats API; internals live in renderer/{parse,format,details,
 * session-stats}.ts (import graph acyclic — see golden test structural guard).
 */

import { loadSessionEntries } from "./renderer/parse.ts";
import { escMd, fmtCost, fmtTokens } from "./renderer/format.ts";
import {
	renderCompactionEntry,
	renderCustomEntry,
	renderMessageEntry,
	renderModelChangeEntry,
	renderThinkingChangeEntry,
} from "./renderer/details.ts";
import type { ConversationTurnState } from "./renderer/details.ts";
import { parseSessionStats } from "./renderer/session-stats.ts";
import type { ParsedSessionStats } from "./renderer/session-stats.ts";

export { parseSessionStats };
export type { ParsedSessionStats };

/** Render a .jsonl session file to Markdown. */
export function renderSessionToMarkdown(
	filepath: string,
	overrides?: { sessionName?: string; mode?: string },
): string {
	const loaded = loadSessionEntries(filepath);
	if (!loaded) return "*Empty session*";

	const sections: string[] = [];
	sections.push(...renderHeader(loaded.entries[0], loaded.entries.length, overrides));
	sections.push(...renderModelSummary(loaded.entries));
	sections.push(...renderTokenTotals(loaded.entries));
	sections.push(...renderToolUsage(loaded.entries));
	sections.push(...renderFileAccess(loaded.entries));
	sections.push(...renderConversation(loaded.entries));
	return sections.join("\n");
}

// ── Section builders ──

function renderHeader(
	header: any,
	entryCount: number,
	overrides?: { sessionName?: string; mode?: string },
): string[] {
	const sections: string[] = [];
	const sid = header.id ?? "?";
	const ts = header.timestamp ?? "?";
	const cwd = header.cwd ?? "?";
	const ver = header.version ?? "?";
	const parentSession = header.parentSession;

	sections.push(`# Session Report`);
	sections.push(``);
	sections.push(`| Field | Value |`);
	sections.push(`|-------|-------|`);
	sections.push(`| **Session** | \`${sid}\` |`);
	sections.push(`| **Start** | \`${ts}\` |`);
	if (overrides?.sessionName) sections.push(`| **Name** | \`${escMd(overrides.sessionName)}\` |`);
	if (overrides?.mode !== undefined) sections.push(`| **Mode** | ${escMd(overrides.mode)} |`);
	sections.push(`| **CWD** | \`${cwd}\` |`);
	sections.push(`| **Version** | ${ver} |`);
	sections.push(`| **Entries** | ${entryCount} |`);
	if (parentSession) sections.push(`| **Parent** | \`${parentSession}\` |`);
	sections.push(``);
	return sections;
}

function renderModelSummary(lines: any[]): string[] {
	const sections: string[] = [];
	const models = new Set<string>();
	const thinkLevels = new Set<string>();
	for (const l of lines) {
		if (l.type === "model_change") models.add(`${l.provider}/${l.modelId}`);
		if (l.type === "thinking_level_change") thinkLevels.add(l.thinkingLevel);
	}
	if (models.size) sections.push(`**Models:** ${[...models].join(", ")}  `);
	if (thinkLevels.size) sections.push(`**Thinking:** ${[...thinkLevels].join(", ")}  `);
	sections.push(``);
	return sections;
}

function renderTokenTotals(lines: any[]): string[] {
	const sections: string[] = [];
	let totalTokens = 0;
	let totalCost = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	for (const l of lines) {
		if (l.type === "message") {
			const usage = l.message?.usage;
			if (usage) {
				inputTokens += usage.input ?? 0;
				outputTokens += usage.output ?? 0;
				cacheRead += usage.cacheRead ?? 0;
				cacheWrite += usage.cacheWrite ?? 0;
				totalTokens += usage.totalTokens ?? 0;
				if (usage.cost?.total) totalCost += usage.cost.total;
			}
		}
	}

	sections.push(`| | |`);
	sections.push(`|---|---|`);
	sections.push(`| **Input tokens** | ${fmtTokens(inputTokens)} |`);
	sections.push(`| **Output tokens** | ${fmtTokens(outputTokens)} |`);
	sections.push(`| **Cache read** | ${fmtTokens(cacheRead)} |`);
	sections.push(`| **Cache write** | ${fmtTokens(cacheWrite)} |`);
	sections.push(`| **Total tokens** | ${fmtTokens(totalTokens)} |`);
	sections.push(`| **Total cost** | ${fmtCost(totalCost)} |`);
	sections.push(``);
	return sections;
}

function renderToolUsage(lines: any[]): string[] {
	const sections: string[] = [];
	const toolCounts: Record<string, { calls: number; errors: number }> = {};
	for (const l of lines) {
		if (l.type === "message" && l.message?.role === "toolResult") {
			const tn = l.message.toolName ?? "?";
			if (!toolCounts[tn]) toolCounts[tn] = { calls: 0, errors: 0 };
			toolCounts[tn].calls++;
			if (l.message.isError) toolCounts[tn].errors++;
		}
		// Include subagent tool-complete entries
		if (
			l.type === "custom" &&
			l.customType === "supervisor" &&
			l.details?.eventType === "tool-complete" &&
			l.details?.toolName
		) {
			const tn = l.details.toolName;
			if (!toolCounts[tn]) toolCounts[tn] = { calls: 0, errors: 0 };
			toolCounts[tn].calls++;
			if (l.details.isError) toolCounts[tn].errors++;
		}
	}

	if (Object.keys(toolCounts).length > 0) {
		sections.push(`## Tool Usage`);
		sections.push(``);
		sections.push(`| Tool | Calls | Errors |`);
		sections.push(`|------|-------|--------|`);
		for (const [name, stats] of Object.entries(toolCounts).sort()) {
			const errStr = stats.errors > 0 ? String(stats.errors) : "—";
			sections.push(`| \`${escMd(name)}\` | ${stats.calls} | ${errStr} |`);
		}
		sections.push(``);
	}
	return sections;
}

function renderFileAccess(lines: any[]): string[] {
	const sections: string[] = [];
	const fileActions: Array<{ action: string; path: string }> = [];
	for (const l of lines) {
		if (l.type === "message" && l.message?.role === "assistant") {
			for (const c of l.message.content ?? []) {
				if (c.type === "toolCall" && c.name === "read") {
					fileActions.push({ action: "📖 read", path: c.arguments?.path ?? "?" });
				}
				if (c.type === "toolCall" && c.name === "write") {
					fileActions.push({ action: "✏️ write", path: c.arguments?.path ?? "?" });
				}
				if (c.type === "toolCall" && c.name === "edit") {
					fileActions.push({ action: "🔧 edit", path: c.arguments?.path ?? "?" });
				}
			}
		}
	}
	if (fileActions.length > 0) {
		sections.push(`## File Access`);
		sections.push(``);
		sections.push(`| Action | File |`);
		sections.push(`|--------|------|`);
		// Deduplicate consecutive same-action same-path
		let last = "";
		for (const fa of fileActions) {
			const key = `${fa.action}|${fa.path}`;
			if (key === last) continue;
			last = key;
			sections.push(`| ${fa.action} | \`${escMd(fa.path)}\` |`);
		}
		sections.push(``);
	}
	return sections;
}

// ── Conversation ──

function renderConversation(lines: any[]): string[] {
	const sections: string[] = [`## Conversation`, ``];

	// Build turns: walk entries, group into user → assistant exchanges
	const turn: ConversationTurnState = { turnIdx: 0, inTurn: false };

	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];

		// Skip header
		if (i === 0 && l.type === "session") continue;

		let rendered: string[];
		if (l.type === "model_change") {
			rendered = renderModelChangeEntry(l);
		} else if (l.type === "thinking_level_change") {
			rendered = renderThinkingChangeEntry(l);
		} else if (l.type === "custom") {
			rendered = renderCustomEntry(l);
		} else if (l.type === "compaction") {
			rendered = renderCompactionEntry(l);
		} else if (l.type === "message") {
			rendered = renderMessageEntry(l, turn);
		} else {
			continue;
		}
		sections.push(...rendered);
	}

	return sections;
}
