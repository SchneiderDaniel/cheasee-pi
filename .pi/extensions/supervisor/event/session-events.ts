// ─── Session Event Processors ────────────────────────────────────
// Thin wrapper: converts SDK session events to NormalizedEvent and
// delegates to the shared processNormalizedEvent.
//
// Owns: SessionEvent type.
// Delegates: processSessionEvent() → sessionEventToNormalizedEvent() + processNormalizedEvent().

import type { AgentRunState } from "../config/types.ts";
import { pushLog } from "../agent/stream.ts";
import { sessionEventToNormalizedEvent, processNormalizedEvent } from "./adapter.ts";
import { phasePriority } from "./types.ts";

// ─── Re-exports for backward compat ───────────────────────────────

export { phasePriority } from "./types.ts";

// ─── Session Event Types ───────────────────────────────────────────

/** Typed session event union for SDK events. */
export type SessionEvent = Record<string, unknown> & {
	type: string;
	toolName?: string;
	toolCallId?: string;
	args?: Record<string, unknown>;
	isError?: boolean;
	result?: unknown;
	assistantMessageEvent?: Record<string, unknown> & {
		type: string;
		delta?: string;
		message?: Record<string, unknown> & {
			role?: string;
			content?: Array<Record<string, unknown> & { type: string; text?: string; thinking?: string }>;
			usage?: { totalTokens?: number; input?: number; output?: number };
		};
	};
	message?: Record<string, unknown> & {
		role?: string;
		content?: Array<Record<string, unknown> & { type: string; text?: string; thinking?: string }>;
		toolName?: string;
		usage?: { totalTokens?: number; input?: number; output?: number };
	};
};

// ─── Event → State Mapping ─────────────────────────────────────────

/**
 * Process a single session event — thin wrapper that converts to
 * NormalizedEvent and delegates to the shared processor.
 */
export function processSessionEvent(
	ev: SessionEvent,
	state: AgentRunState,
): { flush: boolean; workingChange: boolean } {
	const normalized = sessionEventToNormalizedEvent(ev);
	if (!normalized) return { flush: false, workingChange: false };
	return processNormalizedEvent(normalized, state);
}

// ─── Tool Call Formatting ──────────────────────────────────────────
// formatToolCall() converts tool name + args to formatted string matching
// native pi rendering style. isToolCallLine() detects formatted tool call
// lines for downstream consumers (extractLastJson, message-renderer, etc.).

/**
 * Format a tool call into native pi rendering style.
 *
 * | Tool | Format |
 * |------|--------|
 * | bash | `$ command` |
 * | read | `read /path/file.ts:10-30` |
 * | write | `write /path/file.ts (N lines)` |
 * | edit | `edit /path/file.ts` |
 * | grep | `grep /pattern/ in /dir` |
 * | ls | `ls /path` |
 * | find | `find /path` |
 * | ripgrep_search | `rg "query" in dir` |
 * | others | `toolName: {"key":"val"}` (JSON preview, ≤80 chars) |
 */
export function formatToolCall(toolName: string, args?: Record<string, unknown> | null): string {
	const a = args ?? {};

	switch (toolName) {
		case "bash": {
			const cmd = a.command;
			if (typeof cmd === "string" && cmd.trim()) return `$ ${cmd}`;
			return "$";
		}

		case "read": {
			const path = a.path;
			const offset = a.offset;
			const limit = a.limit;
			let result = "read";
			if (typeof path === "string" && path) {
				result += ` ${path}`;
				if (typeof offset === "number") {
					result += `:${offset}`;
					if (typeof limit === "number") {
						result += `-${limit}`;
					} else {
						result += "-";
					}
				}
			}
			return result;
		}

		case "write": {
			const path = a.path;
			const content = a.content;
			let result = "write";
			if (typeof path === "string" && path) {
				result += ` ${path}`;
				const lineCount =
					typeof content === "string" ? (content === "" ? 0 : content.split("\n").length) : 0;
				const label = lineCount === 1 ? "line" : "lines";
				result += ` (${lineCount} ${label})`;
			}
			return result;
		}

		case "edit": {
			const path = a.path;
			if (typeof path === "string" && path) return `edit ${path}`;
			return "edit";
		}

		case "grep": {
			const pattern = a.pattern;
			const path = a.path;
			let result = "grep";
			if (typeof pattern === "string" && pattern) {
				result += ` /${pattern}/`;
			}
			if (typeof path === "string" && path) {
				result += ` in ${path}`;
			}
			return result;
		}

		case "ripgrep_search": {
			const query = a.query;
			const directory = a.directory;
			let result = "rg";
			if (typeof query === "string" && query) {
				result += ` "${query}"`;
			}
			if (typeof directory === "string" && directory) {
				result += ` in ${directory}`;
			}
			return result;
		}

		case "ls": {
			const path = a.path;
			if (typeof path === "string" && path) return `ls ${path}`;
			return "ls";
		}

		case "find": {
			const path = a.path;
			if (typeof path === "string" && path) return `find ${path}`;
			return "find";
		}

		default: {
			// Fallback: toolName: JSON-preview (≤80 chars)
			let preview: string;
			try {
				preview = JSON.stringify(a);
			} catch {
				preview = String(a);
			}
			if (preview.length > 80) {
				preview = preview.slice(0, 77) + "...";
			}
			return `${toolName}: ${preview}`;
		}
	}
}

/**
 * Detect whether a line is a formatted tool call line.
 * Used by extractLastJson, message-renderer, extractSummaryLine, and stripNoise
 * to filter / colorize tool call entries.
 */
export function isToolCallLine(line: string): boolean {
	if (!line) return false;

	// Bash format: starts with "$ " or is bare "$"
	if (line.startsWith("$ ") || line === "$") return true;

	// Bare known tool name (no args)
	if (
		line === "edit" ||
		line === "find" ||
		line === "grep" ||
		line === "ls" ||
		line === "read" ||
		line === "rg" ||
		line === "write"
	) {
		return true;
	}

	// Tool-name-prefixed formats: "read ...", "write ...", etc.
	// Match the first word against known tool names followed by a space
	const spaceIdx = line.indexOf(" ");
	if (spaceIdx > 0) {
		const firstWord = line.slice(0, spaceIdx);
		// Known short tool names (no colon)
		if (
			firstWord === "edit" ||
			firstWord === "find" ||
			firstWord === "grep" ||
			firstWord === "ls" ||
			firstWord === "read" ||
			firstWord === "rg" ||
			firstWord === "write"
		) {
			return true;
		}
		// Fallback format: "toolName: ..." where toolName has word characters before ":"
		// This catches "web_search: {...}", "ripgrep_search: {...}", etc.
		// It does NOT catch emoji-prefixed metadata lines ("🔧", "💭", etc.)
		// because emoji characters are not ASCII word characters.
		if (firstWord.length > 1 && firstWord.endsWith(":") && line[spaceIdx] === " ") {
			const prefix = firstWord.slice(0, -1); // remove ":"
			if (prefix && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(prefix)) {
				return true;
			}
		}
	}

	return false;
}
