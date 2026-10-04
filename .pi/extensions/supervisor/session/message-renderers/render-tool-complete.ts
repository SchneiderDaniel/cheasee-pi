import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { formatTokensInt } from "../../lib/formatting.ts";
import { renderThinkingBlock } from "../../lib/render-helpers.ts";
import type { RendererFn } from "./types.ts";

/**
 * Tool complete: colored header + stats/thinking/error/footer wrapped in
 * one Box with status background. Decomposed into small helpers (header is
 * inlined, stats/highlight are extracted) to honor the 100-line ceiling.
 */
export const renderToolComplete: RendererFn = (message, _options, theme) => {
	const raw = (message as any).details;
	const icon = raw.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const paramsPart = raw.params ? ` ${theme.fg("warning", raw.params)}` : "";
	const headerText = `${icon} ${theme.style(raw.toolName, { fg: "toolTitle", bold: true })}: \`${raw.args}\`${paramsPart}`;
	const bgFn = (l: string) =>
		raw.isError ? theme.style(l, { bg: "toolErrorBg" }) : theme.style(l, { bg: "toolSuccessBg" });

	// ponytail: native tool-execution style — one Box with status bg wraps content.
	const c = new Box(1, 1, bgFn);
	c.addChild(new Text(headerText, 0, 0));

	const stats = statsLine(raw, theme);
	if (stats) {
		c.addChild(new Text(theme.style(stats, { fg: "muted" }), 0, 0));
	}

	// Tool result output — Markdown with keyword highlighting
	if (raw.resultText) {
		const mdTheme = getMarkdownTheme();
		c.addChild(new Markdown(highlightResultText(raw.resultText, theme), 0, 0, mdTheme));
	}

	// Thinking block
	if (raw.thinking) {
		const normalized = raw.thinking.replace(/^ {4,}(```+)/gm, "$1");
		if (raw.resultText) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(theme.fg("muted", "── Thinking ──"), 0, 0));
		}
		renderThinkingBlock(c, normalized, theme);
	}

	// Error reason
	if (raw.isError && raw.errorReason) {
		c.addChild(new Text(theme.fg("error", `✗ ${raw.errorReason}`), 0, 0));
	}

	// Duration footer (like native pi's "Took Xs" at end)
	if (raw.toolDurationMs !== undefined) {
		c.addChild(new Spacer(1));
		const secs = (raw.toolDurationMs / 1000).toFixed(1);
		c.addChild(new Text(theme.fg("muted", `Took ${secs}s`), 0, 0));
	}

	return c;
};

/** Stats segment: toolIndex, duration, tool/token counters, errors, compaction. */
function statsLine(raw: any, theme: any): string {
	const parts: string[] = [];
	if (raw.toolIndex) {
		parts.push(raw.toolIndex);
	}
	if (raw.toolDurationMs !== undefined) {
		const secs = (raw.toolDurationMs / 1000).toFixed(1);
		parts.push(`(${secs}s)`);
	}
	const tc = raw.runningToolCount;
	if (tc !== undefined) {
		const maxT = raw.maxToolCalls;
		if (maxT && maxT > 0) {
			parts.push(`${tc}/${maxT} tools`);
		} else {
			parts.push(`${tc} tools`);
		}
	}
	const tok = raw.runningTokenCount;
	if (tok !== undefined) {
		const maxTok = raw.agentTokenBudget;
		if (maxTok && maxTok > 0) {
			parts.push(`${formatTokensInt(tok)}/${formatTokensInt(maxTok)} tok`);
		} else {
			parts.push(`${tok} tok`);
		}
	}
	const err = raw.errorCount ?? 0;
	if (err > 0) {
		parts.push(`${err} err`);
	}
	if (raw.compacted) {
		parts.push("⚠ compacted");
	}
	return parts.join(" · ");
}

/** Keyword highlighting for tool result lines (status words, counts, paths). */
function highlightResultText(resultText: string, theme: any): string {
	return resultText
		.split("\n")
		.map((l: string) => {
			// Keep leading whitespace OUTSIDE the ANSI wrap so Markdown still sees
			// the original indentation — styling must not change visible text.
			const indent = l.match(/^\s*/)?.[0] ?? "";
			const body = l.slice(indent.length);
			// Keyword highlighting for major status words
			if (/^(error|fail|failed|denied|enoent|not found|blocked)/i.test(body)) {
				return indent + theme.fg("error", body);
			}
			if (/^(success|ok|done|completed|approved)/i.test(body)) {
				return indent + theme.fg("success", body);
			}
			if (/^(warning|warn|caution)/i.test(body)) {
				return indent + theme.fg("warning", body);
			}
			// Match count lines
			if (/\d+ matches/i.test(body) || /Matches returned: \d+/i.test(body)) {
				return indent + theme.fg("success", body);
			}
			// File:line entries from search results
			if (/^\d+\.\s+\S+:\d+:/.test(l)) {
				const sep = l.indexOf(":");
				if (sep > 0) {
					return theme.fg("dim", l.slice(0, sep + 1)) + theme.fg("accent", l.slice(sep + 1));
				}
			}
			// Omitted long line entries
			if (/\[omitted long line/i.test(l) || /\[truncated/i.test(l)) {
				return indent + theme.fg("muted", body);
			}
			// Paths with known patterns (.ts, .js, .json, etc.)
			if (/^\/[\w/.-]+\.[a-z]+:/.test(l)) {
				const colonIdx = l.indexOf(":");
				if (colonIdx > 0) {
					return theme.fg("accent", l.slice(0, colonIdx)) + theme.fg("dim", l.slice(colonIdx));
				}
			}
			return l;
		})
		.join("\n");
}
