// ─── Subagent Tool Rendering ────────────────────────────────────────
// TUI renderCall and renderResult for the subagent tool.
// Provides native-looking inline rendering with expand/collapse via Ctrl+O.

import {
	Container,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { formatTokens, formatDuration, getTermWidth, boldText } from "../lib/formatting.ts";
import { formatToolCall } from "../event/session-events.ts";
import type { SubagentDetails, SubagentToolCall, AgentToolResult } from "./types.ts";

// ─── Constants ──────────────────────────────────────────────────────

const MAX_TASK_PREVIEW_CHARS = 80;
const MAX_EXPANDED_TOOL_CALLS = 30;
const MAX_EXPANDED_OUTPUT_CHARS = 8_000;

// ─── renderCall ─────────────────────────────────────────────────────
// Renders the tool call line: "subagent architect [task preview]"

export function renderSubagentCall(
	args: Record<string, unknown>,
	theme: { fg: (color: string, text: string) => string },
	_context: { cwd?: string },
): import("@earendil-works/pi-tui").Component {
	const agent = (args.agent as string) || "?";
	const task = (args.task as string) || "";

	// Build a short task preview (first line or truncated)
	let taskPreview = task.split("\n")[0] || "";
	if (taskPreview.length > MAX_TASK_PREVIEW_CHARS) {
		taskPreview = taskPreview.slice(0, MAX_TASK_PREVIEW_CHARS - 3) + "...";
	}

	const label = `subagent ${agent}`;
	const detail = taskPreview ? ` — ${taskPreview}` : "";
	const line = `${theme.fg("toolTitle", label)}${theme.fg("dim", detail)}`;

	return new Text(line, 1, 1);
}

// ─── renderResult ───────────────────────────────────────────────────
// Renders the tool result with collapsed (default) and expanded (Ctrl+O) views.

export function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	options: { expanded: boolean; isPartial: boolean },
	theme: { fg: (color: string, text: string) => string },
	_context: { cwd?: string },
): import("@earendil-works/pi-tui").Component {
	const details = result.details;
	const w = Math.max(40, getTermWidth() - 4);
	const fit = (s: string) => truncateToWidth(s, w);

	// ── Partial / In-Progress State ─────────────────────────────
	if (options.isPartial || !details || details.agentName === undefined) {
		const content0 = result.content?.[0];
		const partialText = content0 && content0.type === "text" ? content0.text : "Running...";
		return new Text(theme.fg("muted", partialText), 1, 1);
	}

	const isSuccess = details.success;
	const statusColor = isSuccess ? "success" : "error";
	const statusIcon = isSuccess ? "✓" : "✗";
	const statusText = isSuccess ? "SUCCESS" : "FAILED";

	// ── Collapsed View (Default) ─────────────────────────────────
	// Shows compact stats line: tokens, cache, cost, model, turns, duration
	const statsParts: string[] = [];

	// Input/Output tokens: ↑N ↓N
	if (details.inputTokens > 0 || details.outputTokens > 0) {
		const inStr = details.inputTokens > 0 ? formatTokens(details.inputTokens) : "0";
		const outStr = details.outputTokens > 0 ? formatTokens(details.outputTokens) : "0";
		statsParts.push(`↑${inStr} ↓${outStr}`);
	}

	// Cache read/write: R N W N
	if (details.cacheRead > 0) statsParts.push(`R${formatTokens(details.cacheRead)}`);
	if (details.cacheWrite > 0) statsParts.push(`W${formatTokens(details.cacheWrite)}`);

	// Cost: $N.NNNN
	if (details.cost > 0) statsParts.push(`$${details.cost.toFixed(4)}`);

	// Model (shortened)
	if (details.model) {
		const shortModel = details.model.split("/").pop() || details.model;
		statsParts.push(shortModel);
	}

	// Turns
	if (details.turnCount > 0) {
		statsParts.push(`${details.turnCount} turn${details.turnCount === 1 ? "" : "s"}`);
	}

	// Duration
	if (details.durationMs > 0) {
		statsParts.push(formatDuration(details.durationMs));
	}

	const collapsedParts: string[] = [];

	// Status line with agent name
	collapsedParts.push(
		fit(
			`${theme.fg(statusColor, statusIcon)} ${theme.fg("toolTitle", boldText(theme, details.agentName))} — ${theme.fg(statusColor, statusText)}`,
		),
	);

	// Stats line
	if (statsParts.length > 0) {
		collapsedParts.push(theme.fg("dim", fit(statsParts.join(" · "))));
	}

	// Summary line
	if (details.summaryLine) {
		collapsedParts.push(theme.fg("dim", fit(details.summaryLine)));
	}

	// If not expanded, return the collapsed view
	if (!options.expanded) {
		return new Text(collapsedParts.join("\n"), 1, 0);
	}

	// ── Expanded View (Ctrl+O) ───────────────────────────────────
	const container = new Container();

	// Header: same as collapsed
	for (const part of collapsedParts) {
		container.addChild(new Text(part, 1, 0));
	}
	container.addChild(new Spacer(1));

	// ── Task Section ─────────────────────────────────────────────
	if (details.taskPrompt) {
		container.addChild(new Text(fit(theme.fg("dim", "── Task ──")), 1, 0));
		const taskLines = details.taskPrompt.split("\n");
		const maxTaskLines = 50;
		const showLines = taskLines.slice(0, maxTaskLines);
		const overflowCount = taskLines.length - maxTaskLines;
		for (const line of showLines) {
			if (!line.trim()) continue;
			const styled = theme.fg("dim", line);
			for (const wrapped of wrapTextWithAnsi(styled, w)) {
				container.addChild(new Text(wrapped, 1, 0));
			}
		}
		if (overflowCount > 0) {
			const notice =
				overflowCount === 1
					? theme.fg("muted", "… [1 more line]")
					: theme.fg("muted", `… [${overflowCount} more lines]`);
			container.addChild(new Text(fit(notice), 1, 0));
		}
		container.addChild(new Spacer(1));
	}

	// ── Tool Calls Section ───────────────────────────────────────
	if (details.toolCalls && details.toolCalls.length > 0) {
		container.addChild(new Text(fit(theme.fg("dim", "── Tools ──")), 1, 0));
		const displayCalls = details.toolCalls.slice(0, MAX_EXPANDED_TOOL_CALLS);
		for (const tc of displayCalls) {
			const formatted = formatToolCall(tc.name, tc.args);
			container.addChild(new Text(fit(theme.fg("toolTitle", `  ${formatted}`)), 1, 0));
		}
		if (details.toolCalls.length > MAX_EXPANDED_TOOL_CALLS) {
			const overflow = details.toolCalls.length - MAX_EXPANDED_TOOL_CALLS;
			container.addChild(new Text(fit(theme.fg("muted", `  … ${overflow} more tool calls`)), 1, 0));
		}
		container.addChild(new Spacer(1));
	}

	// ── 💭 Thinking & Output Section ────────────────────────────
	const content0 = result.content?.[0];
	const outputText = content0 && content0.type === "text" ? content0.text : "";
	if (outputText.trim()) {
		container.addChild(new Text(fit(theme.fg("dim", "── 💭 Thinking & Output ──")), 1, 0));

		// Truncate output for display (full content is in result.content)
		const displayOutput =
			outputText.length > MAX_EXPANDED_OUTPUT_CHARS
				? outputText.slice(0, MAX_EXPANDED_OUTPUT_CHARS) +
					`\n\n… [truncated: ${outputText.length - MAX_EXPANDED_OUTPUT_CHARS} more chars]`
				: outputText;

		// Use Markdown renderer for the output text
		const mdTheme = getMarkdownTheme();
		container.addChild(new Markdown(displayOutput, 1, 0, mdTheme));
		container.addChild(new Spacer(1));
	}

	// ── Footer Stats Line ────────────────────────────────────────
	const footerParts: string[] = [];

	if (details.turnCount > 0) {
		footerParts.push(`${details.turnCount} turn${details.turnCount === 1 ? "" : "s"}`);
	}
	if (details.inputTokens > 0 || details.outputTokens > 0) {
		const inStr = details.inputTokens > 0 ? formatTokens(details.inputTokens) : "0";
		const outStr = details.outputTokens > 0 ? formatTokens(details.outputTokens) : "0";
		footerParts.push(`↑${inStr} ↓${outStr}`);
	}
	if (details.cacheRead > 0) footerParts.push(`R${formatTokens(details.cacheRead)}`);
	if (details.cacheWrite > 0) footerParts.push(`W${formatTokens(details.cacheWrite)}`);
	if (details.cost > 0) footerParts.push(`$${details.cost.toFixed(4)}`);

	if (details.model) {
		const shortModel = details.model.split("/").pop() || details.model;
		footerParts.push(shortModel);
	}
	if (details.durationMs > 0) {
		footerParts.push(formatDuration(details.durationMs));
	}

	if (footerParts.length > 0) {
		container.addChild(new Text(fit(theme.fg("dim", footerParts.join(" · "))), 1, 0));
	}

	return container;
}
