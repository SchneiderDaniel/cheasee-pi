import { Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { formatDuration, getTermWidth } from "../../lib/formatting.ts";
import { formatTokens } from "../../../lib/format-tokens.ts";
import { thinkingLabel, thinkingColor } from "../../../lib/thinking-level.ts";
import { subtleColor, renderTextLines, renderToolCallText } from "../../lib/render-helpers.ts";
import { MAX_EXPANDED_TOOL_CALLS } from "./constants.ts";
import { buildNestedStats, formatNestedStats } from "../nested-stats.ts";
import type { SubagentDetails, AgentToolResult } from "../../subagent/types.ts";
import type { RendererFn } from "./types.ts";

/**
 * Subagent result: rich stats view — collapsed (Text) or expanded (Container).
 * Hosts the relocated renderSubagentResultInline (only consumer of it), so
 * message-renderers/* never import back from message-renderer.ts.
 */
export const renderSubagentResult: RendererFn = (message, options, theme, cwd) => {
	const { expanded } = options || { expanded: false };
	const rawDetails = (message as any).details;
	const subagentResult: AgentToolResult<SubagentDetails> = {
		content: rawDetails.content || [],
		details: rawDetails.details || rawDetails,
	};
	return renderSubagentResultInline(subagentResult, expanded, theme, cwd);
};

/**
 * Inline rich stats view for eventType: "subagent-result".
 * Ported from the deleted renderSubagentResult — renders collapsed (Text)
 * or expanded (Container) views identical to the old subagent tool result.
 */
function renderSubagentResultInline(
	subagentResult: AgentToolResult<SubagentDetails>,
	expanded: boolean,
	theme: any,
	cwd?: string,
): import("@earendil-works/pi-tui").Component {
	const details = subagentResult.details;
	const w = Math.max(40, getTermWidth() - 4);
	const fit = (s: string) => truncateToWidth(s, w);

	if (!details || details.agentName === undefined) {
		const content0 = subagentResult.content?.[0];
		const partialText = content0 && content0.type === "text" ? content0.text : "Running...";
		return new Text(theme.style(partialText, { fg: subtleColor(theme) }), 1, 1);
	}

	const isSuccess = details.success;
	const statusColor = isSuccess ? "success" : "error";
	const statusIcon = isSuccess ? "✓" : "✗";
	const statusText = isSuccess ? "SUCCESS" : "FAILED";
	const nestedStats = buildNestedStats(details);
	const subtle = subtleColor(theme);

	// ── Stats Parts (shared) ────────────────────────────────────
	const statsParts: string[] = [];
	const tl = thinkingLabel(details.thinkingLevel);
	if (tl) statsParts.push(tl);
	if (details.inputTokens > 0 || details.outputTokens > 0) {
		const inStr = details.inputTokens > 0 ? formatTokens(details.inputTokens) : "0";
		const outStr = details.outputTokens > 0 ? formatTokens(details.outputTokens) : "0";
		statsParts.push(`↑${inStr} ↓${outStr}`);
	}
	if (details.cacheRead > 0) statsParts.push(`R${formatTokens(details.cacheRead)}`);
	if (details.cacheWrite > 0) statsParts.push(`W${formatTokens(details.cacheWrite)}`);
	if (details.cost > 0) statsParts.push(`$${details.cost.toFixed(4)}`);
	if (details.model) {
		const shortModel = details.model.split("/").pop() || details.model;
		statsParts.push(shortModel);
	}
	if (details.turnCount > 0) {
		statsParts.push(`${details.turnCount} turn${details.turnCount === 1 ? "" : "s"}`);
	}
	if (details.durationMs > 0) {
		statsParts.push(formatDuration(details.durationMs));
	}

	const collapsedParts: string[] = [];
	collapsedParts.push(
		fit(
			`${theme.style(statusIcon, { fg: statusColor })} ${theme.style(details.agentName, { fg: "toolTitle", bold: true })} — ${theme.style(statusText, { fg: statusColor })}`,
		),
	);
	if (statsParts.length > 0) {
		collapsedParts.push(theme.style(fit(statsParts.join(" · ")), { fg: subtle }));
	}
	if ((details.errorCount ?? 0) > 0) {
		collapsedParts.push(theme.style(fit(`${details.errorCount} err`), { fg: subtle }));
	}
	if (details.summaryLine) {
		collapsedParts.push(theme.style(fit(details.summaryLine), { fg: subtle }));
	}

	// ── Collapsed View ──────────────────────────────────────────
	if (!expanded) {
		return new Text(collapsedParts.join("\n"), 1, 0);
	}

	// ── Expanded View ───────────────────────────────────────────
	const container = new Container();
	for (const part of collapsedParts) {
		container.addChild(new Text(part, 1, 0));
	}
	container.addChild(new Spacer(1));

	// Task section
	if (details.taskPrompt) {
		container.addChild(new Text(fit(theme.style("── Task ──", { fg: subtle })), 1, 0));
		const taskLines = details.taskPrompt.split("\n");
		const maxTaskLines = 50;
		const showLines = taskLines.slice(0, maxTaskLines);
		const overflowCount = taskLines.length - maxTaskLines;
		renderTextLines(container, showLines, theme, w);
		if (overflowCount > 0) {
			const notice =
				overflowCount === 1
					? theme.style("… [1 more line]", { fg: subtle })
					: theme.style(`… [${overflowCount} more lines]`, { fg: subtle });
			container.addChild(new Text(fit(notice), 1, 0));
		}
		container.addChild(new Spacer(1));
	}

	// Tool calls + nested-call section
	const hasTopLevelTools = !!details.toolCalls && details.toolCalls.length > 0;
	if (hasTopLevelTools || nestedStats.recorded > 0) {
		container.addChild(new Text(fit(theme.style("── Tools ──", { fg: subtle })), 1, 0));
		if (details.toolCalls && details.toolCalls.length > 0) {
			const displayCalls = details.toolCalls.slice(0, MAX_EXPANDED_TOOL_CALLS);
			for (const tc of displayCalls) {
				const formatted = renderToolCallText(tc.name, tc.args, cwd ?? process.cwd());
				container.addChild(new Text(fit(theme.style(`  ${formatted}`, { fg: "toolTitle" })), 1, 0));
			}
			if (details.toolCalls.length > MAX_EXPANDED_TOOL_CALLS) {
				const overflow = details.toolCalls.length - MAX_EXPANDED_TOOL_CALLS;
				container.addChild(new Text(fit(theme.style(`  … ${overflow} more tool calls`, { fg: subtle })), 1, 0));
			}
		}
		const nestedSummary = formatNestedStats(nestedStats);
		if (nestedSummary) {
			container.addChild(new Text(fit(theme.style(nestedSummary, { fg: subtle })), 1, 0));
		}
		container.addChild(new Spacer(1));
	}

	// Output preview (last 500 chars of subagent output, typically the JSON artifact)
	const content0 = subagentResult.content?.[0];
	const outputText = content0 && content0.type === "text" ? content0.text : "";
	if (outputText.trim()) {
		const preview =
			outputText.length > 500
				? `…[last 500 of ${outputText.length} chars]\n` + outputText.slice(-500)
				: outputText;
		container.addChild(new Text(fit(theme.style("── Output Preview ──", { fg: subtle })), 1, 0));
		const mdTheme = getMarkdownTheme();
		container.addChild(new Markdown(preview, 1, 0, mdTheme));
		container.addChild(new Spacer(1));
	}

	// Footer stats line
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
	const thinkingLevelStr = thinkingLabel(details.thinkingLevel);
	if (thinkingLevelStr) {
		const thinkingToken = thinkingColor(details.thinkingLevel);
		// `dim` is faint on light terminals: fall back to the appearance-aware
		// subtle token there, while keeping semantic tokens (accent/warning/…).
		footerParts.push(theme.style(thinkingLevelStr, { fg: thinkingToken === "dim" ? subtle : thinkingToken }));
	}
	if (details.model) {
		const shortModel = details.model.split("/").pop() || details.model;
		footerParts.push(shortModel);
	}
	if (details.durationMs > 0) {
		footerParts.push(formatDuration(details.durationMs));
	}
	if (footerParts.length > 0) {
		container.addChild(new Text(fit(theme.style(footerParts.join(" · "), { fg: subtle })), 1, 0));
	}

	return container;
}

