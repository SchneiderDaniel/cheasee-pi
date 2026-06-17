// ─── Message Renderer ──────────────────────────────────────────────
// pi.registerMessageRenderer() callback + TUI rendering helpers.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getTermWidth } from "../lib/formatting.ts";
import { renderThinkingBlock } from "../lib/render-helpers.ts";
import { renderSubagentResult } from "../subagent/renderer.ts";
import type { SubagentDetails } from "../subagent/types.ts";

export function createMessageRenderer(pi: ExtensionAPI) {
	return (message: any, options: any, theme: any) => {
		const { expanded } = options || { expanded: false };
		const rawDetails = (message as any).details;

		// ── Tool call result: colored header + stats/thinking/error ─
		interface ToolCallDetail {
			name: string;
			args: string;
			params?: string;
			resultText?: string;
			isError: boolean;
			thinking?: string;
			errorReason?: string;
			toolIndex?: string;
			runningTokenCount?: number;
			runningToolCount?: number;
			toolDurationMs?: number;
			errorCount?: number;
			maxToolCalls?: number;
			agentTokenBudget?: number;
			compacted?: boolean;
		}
		const toolCallResult = rawDetails?.toolCallResult as ToolCallDetail | undefined;
		if (toolCallResult) {
			const icon = toolCallResult.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const paramsPart = toolCallResult.params
				? ` ${theme.fg("warning", toolCallResult.params)}`
				: "";
			const headerText = `${icon} ${theme.fg("toolTitle", toolCallResult.name)}: \`${toolCallResult.args}\`${paramsPart}`;
			const bgFn = (l: string) =>
				toolCallResult.isError ? theme.bg("toolErrorBg", l) : theme.bg("toolSuccessBg", l);

			const c = new Container();
			// Colored header line with full-width background
			c.addChild(new Text(headerText, 1, 0, bgFn));

			// Tool call index + running stats (duration, tokens, tools, errors, budget, compaction)
			const statsParts: string[] = [];
			if (toolCallResult.toolIndex) {
				statsParts.push(toolCallResult.toolIndex);
			}
			// Per-tool duration
			if (toolCallResult.toolDurationMs !== undefined) {
				const secs = (toolCallResult.toolDurationMs / 1000).toFixed(1);
				statsParts.push(`(${secs}s)`);
			}
			// Tool count with budget proximity
			const tc = toolCallResult.runningToolCount;
			if (tc !== undefined) {
				const maxT = toolCallResult.maxToolCalls;
				if (maxT && maxT > 0) {
					statsParts.push(`${tc}/${maxT} tools`);
				} else {
					statsParts.push(`${tc} tools`);
				}
			}
			// Token count with budget proximity
			const tok = toolCallResult.runningTokenCount;
			if (tok !== undefined) {
				const maxTok = toolCallResult.agentTokenBudget;
				if (maxTok && maxTok > 0) {
					const maxK = maxTok >= 1000 ? `${(maxTok / 1000).toFixed(0)}K` : String(maxTok);
					statsParts.push(`${tok}/${maxK} tok`);
				} else {
					statsParts.push(`${tok} tok`);
				}
			}
			// Error count (only if > 0)
			const err = toolCallResult.errorCount ?? 0;
			if (err > 0) {
				statsParts.push(`${err} ${err === 1 ? "err" : "err"}`);
			}
			// Compaction warning
			if (toolCallResult.compacted) {
				statsParts.push("⚠ compacted");
			}
			if (statsParts.length > 0) {
				c.addChild(new Text(theme.fg("dim", statsParts.join(" · ")), 1, 0));
			}

			// Tool result output (plain text, dim, truncated)
			if (toolCallResult.resultText) {
				// Basic ANSI-like formatting per tool type
				const lines = toolCallResult.resultText.split("\n");
				const formatted = lines
					.map((l) => {
						// Highlight match counts (e.g. "3 matches" or "Matches returned: 5")
						if (/\d+ matches/i.test(l) || /Matches returned: \d+/i.test(l)) {
							return theme.fg("success", l);
						}
						// Highlight matched file:line entries (e.g. "1. src/file.ts:42:hello")
						if (/^\d+\.\s+\S+:\d+:/.test(l)) {
							const sep = l.indexOf(":");
							if (sep > 0) {
								const prefix = l.slice(0, sep + 1);
								const fileLine = l.slice(sep + 1);
								return theme.fg("dim", prefix) + theme.fg("accent", fileLine);
							}
						}
						return l;
					})
					.join("\n");
				c.addChild(new Text(formatted, 1, 1));
			}

			// Thinking with visual separator when both resultText and thinking exist
			if (toolCallResult.thinking) {
				const normalized = toolCallResult.thinking.replace(/^ {4,}(```+)/gm, "$1");
				if (toolCallResult.resultText) {
					c.addChild(new Spacer(1));
					c.addChild(new Text(theme.fg("dim", "── Thinking ──"), 1, 0));
				}
				renderThinkingBlock(c, normalized, theme);
			}

			// Error/reason for blocked tools
			if (toolCallResult.isError && toolCallResult.errorReason) {
				c.addChild(new Text(theme.fg("error", `✗ ${toolCallResult.errorReason}`), 1, 1));
			}

			return c;
		}

		// ── Progress update (split: first line accent, rest Markdown) ─
		if (rawDetails?._progressUpdate && typeof message.content === "string") {
			const text = message.content;
			const firstNl = text.indexOf("\n");
			if (firstNl > 0) {
				const statusLine = text.slice(0, firstNl);
				const rest = text.slice(firstNl + 1);
				const c = new Container();
				c.addChild(new Text(theme.fg("accent", statusLine), 1, 0));
				if (rest.trim()) {
					const mdTheme = getMarkdownTheme();
					c.addChild(new Markdown(rest, 1, 0, mdTheme));
				}
				return c;
			}
			const mdTheme = getMarkdownTheme();
			return new Markdown(text, 1, 0, mdTheme);
		}

		// ── Subagent-compatible result rendering ────────────────
		// If the message carries a _subagentResult, delegate to renderSubagentResult
		// for exact visual parity with LLM-initiated subagent tool calls.
		const subagentResult = rawDetails?._subagentResult as
			| import("../subagent/types.ts").AgentToolResult<SubagentDetails>
			| undefined;
		if (subagentResult) {
			const isPartial = subagentResult.details?.statusLabel === "IN_PROGRESS";
			return renderSubagentResult(subagentResult, { expanded, isPartial }, theme, {});
		}

		// No details → render as Markdown matching normal assistant message style
		if (!rawDetails && typeof message.content === "string") {
			const mdTheme = getMarkdownTheme();
			return new Markdown(message.content, 1, 1, mdTheme);
		}
		if (!rawDetails) return new Text("(no details)", 1, 1);

		return new Text("(unhandled supervisor message)", 1, 1);
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
