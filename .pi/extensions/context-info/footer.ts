/**
 * Custom footer installer for context-info extension
 *
 * Rich Neovim/lain-inspired status bar with git info, model, thinking level,
 * session timer, token usage, and TPS.
 */

import { truncateToWidth, visibleWidth, hyperlink } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextStatusBarConfig, FooterConfig } from "./types.js";
import {
	formatSessionTimer,
	formatTokens,
	fgHex,
	pickThresholdHex,
	thinkingIcon,
	thinkingColor,
	formatTps,
	formatCacheStats,
	formatCacheHitRate,
	computeTps,
} from "./formatting.ts";

/** Module-scope process start time — captures true pi process launch time */
const processStartTime = Date.now();

export function installFooter(
	ctx: ExtensionContext,
	config: ContextStatusBarConfig | null,
	footerConfig: FooterConfig,
): void {
	// ── Mode guard (Improvement #3): skip footer in non-TUI modes ──
	// ctx.mode is available in pi >=0.78.1; cast for backward compat with v0.74.0 types
	const mode = (ctx as any).mode as string | undefined;
	if (mode !== undefined && mode !== "tui") {
		ctx.ui.setFooter(undefined);
		return;
	}

	const { worktreeName, thinkingLevel } = footerConfig;
	if (!config || config.enabled === false) {
		ctx.ui.setFooter(undefined);
		return;
	}

	const showTimer = config.showTimer;

	ctx.ui.setFooter((tui, theme, footerData) => {
		// Enable clear-on-shrink so stale rows don't persist when footer
		// content shrinks (e.g., supervisor status cleared, footer goes
		// from 2 rows to 1 row). Without this, TUI leaves blank/stale rows.
		tui.setClearOnShrink(true);

		const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubBranch,
			invalidate() {},
			render(width: number): string[] {
				// ── Compute token usage ───────────────────────
				const usage = ctx.getContextUsage();
				const tokens = usage?.tokens ?? null;
				const cw = usage?.contextWindow ?? footerConfig.lastContextWindow.value;
				if (cw && cw > 0) footerConfig.lastContextWindow.value = cw;

				// ── LEFT: Git info ───────────────────────────
				const branch = footerData.getGitBranch();
				let leftStr = "";
				if (branch) {
					leftStr = theme.fg("accent", " ") + theme.fg("muted", branch);
					if (worktreeName) {
						leftStr += " " + theme.fg("dim", `[${worktreeName}]`);
					}
				} else {
					leftStr = theme.fg("dim", "⋄ no git");
				}

				// ── Separator character ──────────────────────
				const sep = theme.fg("dim", "│");

				// ── Extension statuses ───────────────────────
				const extStatuses = footerData.getExtensionStatuses();
				let extStr = "";
				if (extStatuses.size > 0) {
					const parts: string[] = [];
					for (const [, text] of extStatuses) {
						if (text) parts.push(text);
					}
					if (parts.length > 0) extStr = parts.join(" " + sep + " ");
				}

				// ── CENTER: Model + reasoning + tool count ───
				const modelId = ctx.model?.id ?? "?";
				let centerStr = theme.fg("dim", "🧠 ") + theme.fg("accent", modelId);
				if (thinkingLevel) {
					const tIcon = thinkingIcon(thinkingLevel);
					const tColor = thinkingColor(thinkingLevel);
					const reasoningStr = theme.fg(tColor as any, `${tIcon} ${thinkingLevel}`);
					centerStr += " " + theme.fg("dim", "·") + " " + reasoningStr;
				}

				// ── Tool call counter ─────────────────────────
				const toolStr =
					theme.fg("dim", "🔧") + " " + theme.fg("muted", String(footerConfig.toolCallCount.value));
				centerStr += " " + theme.fg("dim", "·") + " " + toolStr;

				// ── RIGHT: Session timer + token usage + percentage ──
				let rightStr = "";

				// Compute timer string
				let timerStr = "";
				if (showTimer) {
					const elapsed = Date.now() - processStartTime;
					const rawTimer = formatSessionTimer(elapsed);
					timerStr = theme.fg("dim", rawTimer);
				}

				// Compute token display string
				let tokenDisplay = "";
				if (tokens !== null && tokens !== undefined) {
					const currentFmt = formatTokens(tokens);
					const maxFmt = footerConfig.lastContextWindow.value
						? formatTokens(footerConfig.lastContextWindow.value)
						: "?";
					const pct =
						footerConfig.lastContextWindow.value && footerConfig.lastContextWindow.value > 0
							? Math.round((tokens / footerConfig.lastContextWindow.value) * 100)
							: null;

					const usageHex = pickThresholdHex(tokens, config.thresholds);

					const tokenText = `${currentFmt}/${maxFmt}`;
					tokenDisplay = theme.fg("dim", "◉ ") + fgHex(usageHex, tokenText);

					if (pct !== null) {
						const pctColor = pct >= 90 ? "error" : pct >= 70 ? "warning" : "dim";
						tokenDisplay += " " + theme.fg(pctColor, `[${pct}%]`);
					}
				} else if (footerConfig.lastContextWindow.value) {
					tokenDisplay = theme.fg(
						"dim",
						`◉ .../${formatTokens(footerConfig.lastContextWindow.value)}`,
					);
				} else {
					tokenDisplay = theme.fg("dim", "◉ .../?");
				}

				// Combine timer and token display
				if (timerStr && tokenDisplay) {
					rightStr = `${timerStr} \u00b7 ${tokenDisplay}`;
				} else if (timerStr) {
					rightStr = timerStr;
				} else {
					rightStr = tokenDisplay;
				}

				// ── TPS computation ───────────────────────────
				const computed = computeTps(footerConfig.tpsSamples);
				if (computed !== null) {
					footerConfig.lastComputedTps.value = computed;
				}

				// ── Build row 1: left │ center │ right ──────────
				const leftW = visibleWidth(leftStr);
				const centerW = visibleWidth(centerStr);
				const rightW = visibleWidth(rightStr);
				const sepUnit = 3;

				let row1: string;
				if (leftW + centerW + rightW + 2 * sepUnit <= width) {
					const leftSection = leftStr + " " + sep + " ";
					const centerSection = centerStr + " " + sep + " ";
					const beforeRight = leftSection + centerSection;
					const beforeRightW = visibleWidth(beforeRight);
					const padForRight = Math.max(0, width - beforeRightW - rightW);
					row1 = beforeRight + " ".repeat(padForRight) + rightStr;
				} else if (leftW + rightW + sepUnit <= width) {
					const leftSection = leftStr + " " + sep + " ";
					const leftSectionW = visibleWidth(leftSection);
					const padBeforeRight = Math.max(0, width - leftSectionW - rightW);
					row1 = leftSection + " ".repeat(padBeforeRight) + rightStr;
				} else {
					row1 = " ".repeat(Math.max(0, width - rightW)) + rightStr;
				}

				row1 = truncateToWidth(row1, width);

				// ── Build row 2 (ext statuses left, TPS + cache right) ──
				const left2 = extStr || "";
				const rightParts: string[] = [];
				if (config.showTps) {
					const tpsDisplay = formatTps(footerConfig.lastComputedTps.value);
					rightParts.push(theme.fg("dim", tpsDisplay));
				}
				if (config.showCache) {
					const cacheStr = formatCacheStats(footerConfig.cacheRead, footerConfig.cacheWrite);
					rightParts.push(theme.fg("dim", cacheStr));
					// ── CH display (Improvement #1) ────────────
					const chStr = formatCacheHitRate(footerConfig.cacheHitRate);
					if (chStr) {
						rightParts.push(theme.fg("dim", chStr));
					}
				}
				const right2 = rightParts.join(" " + sep + " ");

				// ── Build row 3: session name/ID + trust status ──
				let row3 = "";
				const row3Parts: string[] = [];

				// Session name (Improvement #2) or session ID fallback
				if (footerConfig.sessionName) {
					row3Parts.push(
						theme.fg("dim", "Session:") + " " + theme.fg("muted", footerConfig.sessionName),
					);
				} else if (footerConfig.sessionId) {
					row3Parts.push(
						theme.fg("dim", "SessionID:") + " " + theme.fg("muted", footerConfig.sessionId),
					);
				}

				// Trust status (Improvement #4)
				if (footerConfig.trustStatus !== undefined) {
					const trustIcon = footerConfig.trustStatus === "trusted" ? "\u{1F512}" : "\u{1F513}";
					row3Parts.push(theme.fg("dim", trustIcon));
				} else {
					row3Parts.push(theme.fg("dim", "\u2753"));
				}

				row3 = row3Parts.join(" " + sep + " ");

				// ── Assemble rows ───────────────────────────────────
				const rows: string[] = [row1];

				if (left2 || right2) {
					const lw = visibleWidth(left2);
					const rw = visibleWidth(right2);
					const gap = Math.max(0, width - lw - rw);
					const row2 = right2
						? left2 + " ".repeat(gap) + right2
						: left2 + " ".repeat(Math.max(0, width - lw));
					rows.push(truncateToWidth(row2, width));
				}

				if (row3) {
					rows.push(truncateToWidth(row3, width));
				}

				// ── Supervisor issue info (row 4) ────────────────
				const issueNumVal = footerConfig.issueNumber?.value;
				if (issueNumVal !== undefined && issueNumVal !== null) {
					const issueRepoVal = footerConfig.issueRepo?.value ?? "";
					const issueTitleVal = footerConfig.issueTitle?.value ?? "";
					const issueUrl = `https://github.com/${issueRepoVal}/issues/${issueNumVal}`;
					const issueLink = hyperlink(theme.fg("accent", `#${issueNumVal}`), issueUrl);
					const sepIssue = theme.fg("dim", "│");

					// Truncate title to 16 visible chars with "..." ellipsis
					const truncatedTitle = truncateToWidth(issueTitleVal, 32, "...");
					const titleStr =
						issueTitleVal.length > 0
							? " " + sepIssue + " " + theme.fg("muted", truncatedTitle)
							: "";

					let row4 = issueLink + titleStr;
					// Pad to fill terminal width so background extends to edge
					const row4w = visibleWidth(row4);
					if (row4w < width) {
						row4 += " ".repeat(width - row4w);
					}
					rows.push(truncateToWidth(row4, width));
				}

				return rows;
			},
		};
	});

	// Also keep the status key clear (footer replaces it)
	ctx.ui.setStatus("contextUsage", undefined);
}
