// ─── Formatting helpers ──────────────────────────────────────────────
// Pure formatting functions — no Pi API, no filesystem side effects.

import { parseAgentOutput, isSuccess as isAgentOutputSuccess } from "../agent/output.ts";
import type { AgentOutput } from "../config/types.ts";

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** Integer-rounded, lowercase k/m token display for compact stats lines.
 *  Values <1000 return raw number; values >=1e6 use lowercase `m`.
 */
export function formatTokensInt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}m`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}

export function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	const sec = Math.round(ms / 1_000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remainSec = sec % 60;
	return `${min}m ${remainSec}s`;
}

export function getTermWidth(): number {
	return process.stdout.columns || 120;
}

export function extractTextFromContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b.type === "text" && b.text)
		.map((b: any) => b.text)
		.join("\n");
}

/** Pull a one-line summary from the agent's text output */
export function extractSummaryLine(
	textOutput: string,
	success: boolean,
	agentName: string,
): string {
	if (!textOutput) return success ? `${agentName} completed` : `${agentName} failed`;

	// Primary: parseAgentOutput for structured summary
	const parseResult = parseAgentOutput(textOutput);
	if (isAgentOutputSuccess(parseResult)) {
		const output = parseResult as AgentOutput;
		if (output.summary) return output.summary;
		// Generate from action + agentName
		const actionLabel = output.action.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
		return `${output.agentName}: ${actionLabel}`;
	}

	// Fallback: text marker detection (backward compat)
	const markers = [
		"ARCHITECTURE_COMPLETE",
		"RESEARCH_COMPLETE",
		"TEST_PLAN_COMPLETE",
		"IMPLEMENTATION_COMPLETE",
		"AUDIT_APPROVED",
		"AUDIT_REJECTED",
	];
	let lastIdx = -1;
	let lastMarker = "";
	for (const marker of markers) {
		const idx = textOutput.lastIndexOf(marker);
		if (idx > lastIdx) {
			lastIdx = idx;
			lastMarker = marker;
		}
	}
	if (lastMarker) {
		return lastMarker
			.replace(/_/g, " ")
			.toLowerCase()
			.replace(/\b\w/g, (c) => c.toUpperCase());
	}

	const firstLine = textOutput
		.split("\n")
		.find(
			(l) =>
				l.trim() &&
				!l.startsWith("🔧") &&
				!l.startsWith("📋") &&
				!l.startsWith("💭") &&
				!isToolCallLine(l.trim()),
		);
	if (firstLine) {
		return firstLine.trim().slice(0, 120);
	}
	return success ? `${agentName} completed` : `${agentName} failed`;
}

// ─── Tool Call Formatting ──────────────────────────────────────────
// formatToolCall() converts tool name + args to formatted string matching
// native pi rendering style. isToolCallLine() detects formatted tool call
// lines for downstream consumers.
// Originally from event/session-events.ts, moved here for Phase 3 cleanup.

/**
 * Format a tool call into native pi rendering style.
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
 */
export function isToolCallLine(line: string): boolean {
	if (!line) return false;

	if (line.startsWith("$ ") || line === "$") return true;

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

	const spaceIdx = line.indexOf(" ");
	if (spaceIdx > 0) {
		const firstWord = line.slice(0, spaceIdx);
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
		if (firstWord.length > 1 && firstWord.endsWith(":") && line[spaceIdx] === " ") {
			const prefix = firstWord.slice(0, -1);
			if (prefix && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(prefix)) {
				return true;
			}
		}
	}

	return false;
}

// ─── Thinking level helpers ─────────────────────────────────────────
// Inline minimal version (no cross-extension import from context-info).
// Matches the same mapping as context-info/formatting.ts for consistency.

/** Map thinking level string to its unicode icon character */
function thinkingIcon(level: string | undefined): string {
	switch (level) {
		case "off":
			return "○";
		case "minimal":
			return "◐";
		case "low":
			return "◑";
		case "medium":
			return "◒";
		case "high":
			return "◓";
		case "xhigh":
			return "●";
		default:
			return "";
	}
}

/** Map thinking level string to a TUI theme color name */
export function thinkingColor(level: string | undefined): string {
	switch (level) {
		case "off":
		case "minimal":
			return "dim";
		case "low":
		case "medium":
			return "muted";
		case "high":
		case "xhigh":
			return "accent";
		default:
			return "dim";
	}
}

/**
 * Format thinking level as "◒ medium" or empty string if not set.
 * Returns empty string for falsy/empty/unknown levels.
 */
export function thinkingLabel(level: string | undefined): string {
	if (!level || !level.trim()) return "";
	const icon = thinkingIcon(level);
	if (!icon) return "";
	return `${icon} ${level}`;
}
