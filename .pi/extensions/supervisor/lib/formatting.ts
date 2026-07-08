// ─── Formatting helpers ──────────────────────────────────────────────
// Pure formatting functions — no Pi API, no filesystem side effects.

import { parseAgentOutput, isSuccess as isAgentOutputSuccess } from "../agent/output.ts";
import type { AgentOutput } from "../config/types.ts";
import { isToolLine } from "./tool-line.ts";

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
	toolNames?: Set<string>,
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
				!isToolLine(l.trim(), toolNames),
		);
	if (firstLine) {
		return firstLine.trim().slice(0, 120);
	}
	return success ? `${agentName} completed` : `${agentName} failed`;
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
