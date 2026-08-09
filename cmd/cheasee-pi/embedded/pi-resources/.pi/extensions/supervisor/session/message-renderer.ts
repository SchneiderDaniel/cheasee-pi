// ─── Message Renderer ──────────────────────────────────────────────
// pi.registerMessageRenderer() callback — dispatches on eventType discriminator.
// One-level dispatch table (session/message-renderers/) replaces the old
// switch (Clean Code ch. 3 — small functions; G23 — one switch rule).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { RENDERERS, fallbackRenderer } from "./message-renderers/index.ts";
import { getTermWidth } from "../lib/formatting.ts";

export function createMessageRenderer(_pi: ExtensionAPI, cwd?: string) {
	return (message: any, options: any, theme: any) => {
		const rawDetails = (message as any).details;

		// No details → render as Markdown
		if (!rawDetails && typeof message.content === "string") {
			const mdTheme = getMarkdownTheme();
			return new Markdown(message.content, 1, 1, mdTheme);
		}
		if (!rawDetails) return new Text("(no details)", 1, 1);

		const eventType = rawDetails.eventType as string | undefined;

		// Dispatch on eventType — RENDERERS[eventType] ?? fallbackRenderer
		return (RENDERERS[eventType ?? ""] ?? fallbackRenderer)(message, options, theme, cwd);
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
