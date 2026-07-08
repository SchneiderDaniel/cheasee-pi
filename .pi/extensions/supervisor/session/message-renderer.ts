// ─── Message Renderer ──────────────────────────────────────────────
// pi.registerMessageRenderer() callback — dispatches on eventType discriminator.
// Single switch(details.eventType) replaces parallel _progressUpdate /
// _subagentResult / toolCallResult branches.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatTokensInt, formatDuration, formatTokens, getTermWidth, thinkingLabel, thinkingColor } from "../lib/formatting.ts";
import { renderTextLines, renderThinkingBlock, renderToolCallText } from "../lib/render-helpers.ts";
import type { SubagentDetails, AgentToolResult } from "../subagent/types.ts";

// ─── Constants (shared with deleted renderSubagentResult) ──────────
const MAX_TASK_PREVIEW_CHARS = 80;
const MAX_EXPANDED_TOOL_CALLS = 30;

/**
 * Inline rich stats view for eventType: "subagent-result".
 * Ported from the deleted renderSubagentResult — renders collapsed (Text)
 * or expanded (Container) views identical to the old subagent tool result.
 */
function renderSubagentResultInline(
	subagentResult: AgentToolResult<SubagentDetails>,
	expanded: boolean,
	theme: any,
): import("@earendil-works/pi-tui").Component {
	const details = subagentResult.details;
	const w = Math.max(40, getTermWidth() - 4);
	const fit = (s: string) => truncateToWidth(s, w);

	if (!details || details.agentName === undefined) {
		const content0 = subagentResult.content?.[0];
		const partialText = content0 && content0.type === "text" ? content0.text : "Running...";
		return new Text(theme.fg("muted", partialText), 1, 1);
	}

	const isSuccess = details.success;
	const statusColor = isSuccess ? "success" : "error";
	const statusIcon = isSuccess ? "✓" : "✗";
	const statusText = isSuccess ? "SUCCESS" : "FAILED";

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
			`${theme.fg(statusColor, statusIcon)} ${theme.fg("toolTitle", details.agentName)} — ${theme.fg(statusColor, statusText)}`,
		),
	);
	if (statsParts.length > 0) {
		collapsedParts.push(theme.fg("dim", fit(statsParts.join(" · "))));
	}
	if (details.summaryLine) {
		collapsedParts.push(theme.fg("dim", fit(details.summaryLine)));
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
		container.addChild(new Text(fit(theme.fg("dim", "── Task ──")), 1, 0));
		const taskLines = details.taskPrompt.split("\n");
		const maxTaskLines = 50;
		const showLines = taskLines.slice(0, maxTaskLines);
		const overflowCount = taskLines.length - maxTaskLines;
		renderTextLines(container, showLines, theme, w);
		if (overflowCount > 0) {
			const notice =
				overflowCount === 1
					? theme.fg("muted", "… [1 more line]")
					: theme.fg("muted", `… [${overflowCount} more lines]`);
			container.addChild(new Text(fit(notice), 1, 0));
		}
		container.addChild(new Spacer(1));
	}

	// Tool calls section
	if (details.toolCalls && details.toolCalls.length > 0) {
		container.addChild(new Text(fit(theme.fg("dim", "── Tools ──")), 1, 0));
		const displayCalls = details.toolCalls.slice(0, MAX_EXPANDED_TOOL_CALLS);
		for (const tc of displayCalls) {
			const formatted = renderToolCallText(tc.name, tc.args, process.cwd());
			container.addChild(new Text(fit(theme.fg("toolTitle", `  ${formatted}`)), 1, 0));
		}
		if (details.toolCalls.length > MAX_EXPANDED_TOOL_CALLS) {
			const overflow = details.toolCalls.length - MAX_EXPANDED_TOOL_CALLS;
			container.addChild(new Text(fit(theme.fg("muted", `  … ${overflow} more tool calls`)), 1, 0));
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
		container.addChild(new Text(fit(theme.fg("dim", "── Output Preview ──")), 1, 0));
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
		footerParts.push(theme.fg(thinkingColor(details.thinkingLevel), thinkingLevelStr));
	}
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

export function createMessageRenderer(pi: ExtensionAPI) {
	return (message: any, options: any, theme: any) => {
		const { expanded } = options || { expanded: false };
		const rawDetails = (message as any).details;

		// No details → render as Markdown
		if (!rawDetails && typeof message.content === "string") {
			const mdTheme = getMarkdownTheme();
			return new Markdown(message.content, 1, 1, mdTheme);
		}
		if (!rawDetails) return new Text("(no details)", 1, 1);

		const eventType = rawDetails.eventType as string | undefined;

		// ═══════════════════════════════════════════════════════════
		// Dispatch on eventType
		// ═══════════════════════════════════════════════════════════

		switch (eventType) {
			// ── Phase change: accent-colored first line + Markdown ──
			case "phase-change": {
				const agentName = rawDetails.agentName as string;
				const phase = rawDetails.phase as string;
				const text = `⏳ ${agentName} — ${phase} phase`;
				if (typeof message.content === "string" && message.content !== text) {
					// Full content with extra info
					const firstNl = message.content.indexOf("\n");
					if (firstNl > 0) {
						const statusLine = message.content.slice(0, firstNl);
						const rest = message.content.slice(firstNl + 1);
						const c = new Container();
						c.addChild(new Text(theme.fg("accent", statusLine), 1, 0));
						if (rest.trim()) {
							const mdTheme = getMarkdownTheme();
							c.addChild(new Markdown(rest, 1, 0, mdTheme));
						}
						return c;
					}
					const mdTheme = getMarkdownTheme();
					return new Markdown(message.content, 1, 0, mdTheme);
				}
				return new Text(theme.fg("accent", text), 1, 0);
			}

			// ── Tool complete: colored header + stats/thinking/error ──
			case "tool-complete": {
				const icon = rawDetails.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const paramsPart = rawDetails.params ? ` ${theme.fg("warning", rawDetails.params)}` : "";
				const headerText = `${icon} ${theme.fg("toolTitle", rawDetails.toolName)}: \`${rawDetails.args}\`${paramsPart}`;
				const bgFn = (l: string) =>
					rawDetails.isError ? theme.bg("toolErrorBg", l) : theme.bg("toolSuccessBg", l);

				// ponytail: native tool-execution style — one Box with status bg wraps content.
				const c = new Box(1, 1, bgFn);
				c.addChild(new Text(headerText, 0, 0));

				// Stats line
				const statsParts: string[] = [];
				if (rawDetails.toolIndex) {
					statsParts.push(rawDetails.toolIndex);
				}
				if (rawDetails.toolDurationMs !== undefined) {
					const secs = (rawDetails.toolDurationMs / 1000).toFixed(1);
					statsParts.push(`(${secs}s)`);
				}
				const tc = rawDetails.runningToolCount;
				if (tc !== undefined) {
					const maxT = rawDetails.maxToolCalls;
					if (maxT && maxT > 0) {
						statsParts.push(`${tc}/${maxT} tools`);
					} else {
						statsParts.push(`${tc} tools`);
					}
				}
				const tok = rawDetails.runningTokenCount;
				if (tok !== undefined) {
					const maxTok = rawDetails.agentTokenBudget;
					if (maxTok && maxTok > 0) {
						statsParts.push(`${formatTokensInt(tok)}/${formatTokensInt(maxTok)} tok`);
					} else {
						statsParts.push(`${tok} tok`);
					}
				}
				const err = rawDetails.errorCount ?? 0;
				if (err > 0) {
					statsParts.push(`${err} ${err === 1 ? "err" : "err"}`);
				}
				if (rawDetails.compacted) {
					statsParts.push("⚠ compacted");
				}
				if (statsParts.length > 0) {
					c.addChild(new Text(theme.fg("muted", statsParts.join(" · ")), 0, 0));
				}

				// Tool result output — Markdown with keyword highlighting
				if (rawDetails.resultText) {
					const lines = rawDetails.resultText.split("\n");
					const formatted = lines
						.map((l: string) => {
							// Keyword highlighting for major status words
							if (/^(error|fail|failed|denied|enoent|not found|blocked)/i.test(l.trim())) {
								return theme.fg("error", l);
							}
							if (/^(success|ok|done|completed|approved)/i.test(l.trim())) {
								return theme.fg("success", l);
							}
							if (/^(warning|warn|caution)/i.test(l.trim())) {
								return theme.fg("warning", l);
							}
							// Match count lines
							if (/\d+ matches/i.test(l) || /Matches returned: \d+/i.test(l)) {
								return theme.fg("success", l);
							}
							// File:line entries from search results
							if (/^\d+\.\s+\S+:\d+:/.test(l)) {
								const sep = l.indexOf(":");
								if (sep > 0) {
									const prefix = l.slice(0, sep + 1);
									const fileLine = l.slice(sep + 1);
									return theme.fg("dim", prefix) + theme.fg("accent", fileLine);
								}
							}
							// Omitted long line entries
							if (/\[omitted long line/i.test(l) || /\[truncated/i.test(l)) {
								return theme.fg("muted", l);
							}
							// Paths with known patterns (.ts, .js, .json, etc.)
							if (/^\/[\w/.-]+\.[a-z]+:/.test(l)) {
								const colonIdx = l.indexOf(":");
								if (colonIdx > 0) {
									return (
										theme.fg("accent", l.slice(0, colonIdx)) + theme.fg("dim", l.slice(colonIdx))
									);
								}
							}
							return l;
						})
						.join("\n");
					const mdTheme = getMarkdownTheme();
					c.addChild(new Markdown(formatted, 0, 0, mdTheme));
				}

				// Thinking block
				if (rawDetails.thinking) {
					const normalized = rawDetails.thinking.replace(/^ {4,}(```+)/gm, "$1");
					if (rawDetails.resultText) {
						c.addChild(new Spacer(1));
						c.addChild(new Text(theme.fg("muted", "── Thinking ──"), 0, 0));
					}
					renderThinkingBlock(c, normalized, theme);
				}

				// Error reason
				if (rawDetails.isError && rawDetails.errorReason) {
					c.addChild(new Text(theme.fg("error", `✗ ${rawDetails.errorReason}`), 0, 0));
				}

				// Duration footer (like native pi's "Took Xs" at end)
				if (rawDetails.toolDurationMs !== undefined) {
					c.addChild(new Spacer(1));
					const secs = (rawDetails.toolDurationMs / 1000).toFixed(1);
					const tookText = rawDetails.isError ? `Took ${secs}s` : `Took ${secs}s`;
					c.addChild(new Text(theme.fg("muted", tookText), 0, 0));
				}

				return c;
			}

			// ── Tool start: accent-colored one-liner ──────────────
			case "tool-start": {
				const agentName = rawDetails.agentName as string;
				const toolName = rawDetails.toolName as string;
				const args = rawDetails.args as string;
				const text = args
					? `⏳ ${agentName} — ${toolName} ${args}`
					: `⏳ ${agentName} — ${toolName}`;
				return new Text(theme.fg("accent", text), 1, 0);
			}

			// ── Subagent result: rich stats view (inlined) ────────
			case "subagent-result": {
				// The details carry the same shape as the old _subagentResult:
				// { eventType: "subagent-result", content, details }
				const subagentResult: AgentToolResult<SubagentDetails> = {
					content: rawDetails.content || [],
					details: rawDetails.details || rawDetails,
				};
				return renderSubagentResultInline(subagentResult, expanded, theme);
			}

			// ── Thinking block ────────────────────────────────────
			case "thinking": {
				const content = rawDetails.content || rawDetails.thinkingText || "";
				const c = new Container();
				renderThinkingBlock(c, content, theme);
				return c;
			}

			// ── Error ─────────────────────────────────────────────
			case "error": {
				const toolName = rawDetails.toolName ? `${rawDetails.toolName}: ` : "";
				const errText = `✗ ${toolName}${rawDetails.errorReason || "Unknown error"}`;
				return new Text(theme.fg("error", errText), 1, 1);
			}

			// ── Budget exceeded ───────────────────────────────────
			case "budget-exceeded": {
				const agentName = rawDetails.agentName || "";
				const tc = rawDetails.toolCount ?? 0;
				const tok = rawDetails.tokenCount ?? 0;
				const warning = `⚠ ${agentName} — budget exceeded (${tc} tools, ${tok} tokens)`;
				return new Text(theme.fg("warning", warning), 1, 1);
			}

			// ── Compaction ────────────────────────────────────────
			case "compaction": {
				return new Text(theme.fg("muted", "⚠ compacted"), 1, 1);
			}

			// ── Unknown / no eventType ────────────────────────────
			default: {
				// ponytail: eventType discriminator is the single source of truth.
				// Old toolCallResult / _subagentResult branches removed (#1071).
				if (typeof message.content === "string") {
					const mdTheme = getMarkdownTheme();
					return new Markdown(message.content, 1, 1, mdTheme);
				}
				return new Text("(unhandled supervisor message)", 1, 1);
			}
		}
	};
}

export function createSummaryRenderer(pi: ExtensionAPI) {
	return (message: any, _options: any, theme: any) => {
		const content = typeof message.content === "string" ? message.content : "";
		const w = Math.max(40, getTermWidth() - 4);
		const fit = (s: string) => truncateToWidth(s, w);

		const c = new Container();

		// Determine status color from header emoji
		const firstLine = content.split("\n")[0] || "";
		let statusColor = "dim";
		if (firstLine.includes("✅")) {
			statusColor = "success";
		} else if (firstLine.includes("❌")) {
			statusColor = "error";
		} else if (firstLine.includes("⏹")) {
			statusColor = "warning";
		}

		const lines = content.split("\n");
		for (const line of lines) {
			if (!line.trim()) continue; // Skip empty lines
			let styledLine: string;
			// Color the header line
			if (line.startsWith("## ")) {
				styledLine = theme.fg(statusColor, line);
			} else if (line.startsWith("| ")) {
				// Table rows — dim but readable
				styledLine = theme.fg("dim", line);
			} else if (line.startsWith("**")) {
				// Bold lines — subtle highlight
				styledLine = theme.fg("dim", line);
			} else {
				styledLine = line;
			}
			for (const wrapped of wrapTextWithAnsi(styledLine, w)) {
				c.addChild(new Text(wrapped, 1, 0));
			}
		}

		return c;
	};
}
