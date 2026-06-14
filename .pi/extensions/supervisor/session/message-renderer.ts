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

export function createMessageRenderer(pi: ExtensionAPI) {
	return (message: any, options: any, theme: any) => {
		const { expanded } = options || { expanded: false };

		const details = message.details as SupervisorMessageDetails | undefined;
		if (!details && typeof message.content === "string") {
			return new Text(message.content, 1, 1);
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

		// Stats line: tools, tokens, duration
		const statsParts: string[] = [];
		if (details.toolCount > 0)
			statsParts.push(`${details.toolCount} tool${details.toolCount === 1 ? "" : "s"}`);
		if (details.tokenCount > 0) statsParts.push(`${formatTokens(details.tokenCount)} tokens`);
		if (details.durationMs > 0) statsParts.push(formatDuration(details.durationMs));
		if (statsParts.length > 0) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", statsParts.join(" · "))), 1, 0));
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

		// Thinking output
		if (details.hasThinking && details.thinkingOutput) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", "── Thinking ──")), 1, 0));
			const thinkingLines = details.thinkingOutput.split("\n");
			for (const line of thinkingLines) {
				if (!line.trim()) continue;
				const styled = theme.fg("dim", line);
				for (const wrapped of wrapTextWithAnsi(styled, w)) {
					c.addChild(new Text(wrapped, 1, 0));
				}
			}
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
			for (const line of preview.split("\n")) {
				if (!line.trim()) continue;
				const styled = theme.fg("dim", line);
				for (const wrapped of wrapTextWithAnsi(styled, w)) {
					c.addChild(new Text(wrapped, 1, 0));
				}
			}
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
