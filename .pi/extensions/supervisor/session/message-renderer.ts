// ─── Message Renderer ──────────────────────────────────────────────
// pi.registerMessageRenderer() callback + TUI rendering helpers.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { SupervisorMessageDetails } from "../config/types.ts";
import {
	Container,
	Markdown,
	Spacer,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatTokens, formatDuration, getTermWidth, boldText } from "../lib/formatting.ts";
import { renderTextLines } from "../lib/render-helpers.ts";
import { renderSubagentResult } from "../subagent/renderer.ts";
import type { SubagentDetails } from "../subagent/types.ts";

export function createMessageRenderer(pi: ExtensionAPI) {
	return (message: any, options: any, theme: any) => {
		const { expanded } = options || { expanded: false };
		const details = message.details as SupervisorMessageDetails | undefined;
		const rawDetails = (message as any).details;

		// ── Tool call result: colored header + stats/thinking/error ─
		interface ToolCallDetail {
			name: string;
			args: string;
			params?: string;
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

			// Thinking (Markdown, no background)
			if (toolCallResult.thinking) {
				const normalized = toolCallResult.thinking.replace(/^ {4,}(```+)/gm, "$1");
				const mdTheme = getMarkdownTheme();
				c.addChild(new Markdown(normalized, 1, 1, mdTheme));
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
		if (!details && typeof message.content === "string") {
			const mdTheme = getMarkdownTheme();
			return new Markdown(message.content, 1, 1, mdTheme);
		}
		if (!details) return new Text("(no details)", 1, 1);

		const w = Math.max(40, getTermWidth() - 4);
		const fit = (s: string) => truncateToWidth(s, w);

		const c = new Container();
		const statusColor = details.success ? "success" : "error";
		const statusIcon = details.success ? "✓" : "✗";
		const statusText = details.success ? "SUCCESS" : "FAILED";

		// Header: status icon + agent name + status
		c.addChild(
			new Text(
				fit(
					`${theme.fg(statusColor, statusIcon)} ${theme.fg("toolTitle", boldText(theme, details.agentName))} — ${theme.fg(statusColor, statusText)}`,
				),
				1,
				0,
			),
		);

		// Stats line: model, token breakdown, cache, cost, tools, duration
		const hasNewFields =
			details.model !== undefined ||
			details.inputTokens !== undefined ||
			details.outputTokens !== undefined ||
			details.cacheRead !== undefined ||
			details.cacheWrite !== undefined ||
			details.cost !== undefined;

		if (hasNewFields) {
			// New format with per-agent usage breakdown
			const statsParts: string[] = [];

			// Model name (shortened: last segment after '/')
			if (details.model) {
				const shortModel = details.model.split("/").pop() || details.model;
				statsParts.push(`model: ${shortModel}`);
			}

			// Input/output token breakdown (↑N ↓N)
			// Only show when at least one is non-zero (omit zero noise)
			const hasInput = details.inputTokens !== undefined && details.inputTokens > 0;
			const hasOutput = details.outputTokens !== undefined && details.outputTokens > 0;
			if (hasInput || hasOutput) {
				const inStr = hasInput ? formatTokens(details.inputTokens!) : "0";
				const outStr = hasOutput ? formatTokens(details.outputTokens!) : "0";
				statsParts.push(`↑${inStr} ↓${outStr}`);
			}

			// Cache read/write (R/W)
			if (details.cacheRead !== undefined && details.cacheRead > 0) {
				statsParts.push(`R${formatTokens(details.cacheRead)}`);
			}
			if (details.cacheWrite !== undefined && details.cacheWrite > 0) {
				statsParts.push(`W${formatTokens(details.cacheWrite)}`);
			}

			// Cost ($N.NNNN) — omit when zero
			if (details.cost !== undefined && details.cost > 0) {
				statsParts.push(`$${details.cost.toFixed(4)}`);
			}

			// Tools
			if (details.toolCount > 0) {
				statsParts.push(`${details.toolCount} tool${details.toolCount === 1 ? "" : "s"}`);
			}

			// Duration (always shown when available)
			if (details.durationMs > 0) {
				statsParts.push(formatDuration(details.durationMs));
			}

			if (statsParts.length > 0) {
				c.addChild(new Spacer(1));
				c.addChild(new Text(fit(theme.fg("dim", statsParts.join(" · "))), 1, 0));
			}
		}

		// Audit score (confidence tracking)
		if (details.auditScore) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("info", `Audit Score: ${details.auditScore}`)), 1, 0));
		}

		// Summary line
		if (details.summaryLine) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", details.summaryLine)), 1, 0));
		}

		// Collapsed view: only show header, stats, audit, summary (no thinking/text/raw)
		if (!expanded) return c;

		// ─── Expanded view ─────────────────────────────────────

		// Task prompt (expanded view only)
		if (details.taskPrompt !== undefined) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", "── Task ──")), 1, 0));
			if (details.taskPrompt.length > 0) {
				const taskLines = details.taskPrompt.split("\n");
				const maxTaskLines = 50;
				const showLines = taskLines.slice(0, maxTaskLines);
				const overflowCount = taskLines.length - maxTaskLines;
				renderTextLines(c, showLines, theme, w);
				if (overflowCount > 0) {
					const notice =
						overflowCount === 1
							? theme.fg("muted", "… [1 more line]")
							: theme.fg("muted", `… [${overflowCount} more lines]`);
					c.addChild(new Text(fit(notice), 1, 0));
				}
			}
		}

		// Thinking output
		if (details.hasThinking && details.thinkingOutput) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", "── Thinking ──")), 1, 0));
			const thinkingLines = details.thinkingOutput.split("\n");
			renderTextLines(c, thinkingLines, theme, w);
		}

		// Text output rendered as Markdown
		if (details.textOutput) {
			c.addChild(new Spacer(1));
			const mdTheme = getMarkdownTheme();
			c.addChild(new Markdown(details.textOutput, 1, 0, mdTheme));
		}

		// Raw output section (if available)
		if (details.hasRawOutput && details.rawOutput) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", "── Raw Output ──")), 1, 0));
			const preview =
				details.rawOutput.length > 500
					? details.rawOutput.slice(0, 500) + "..."
					: details.rawOutput;
			renderTextLines(c, preview.split("\n"), theme, w);
		}

		return c;
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
