/**
 * Custom footer installer for context-info extension
 *
 * Rich Neovim/lain-inspired status bar with git info, model, thinking level,
 * session timer, token usage, and TPS.
 */

import { readFileSync } from "node:fs";
import { truncateToWidth, visibleWidth, hyperlink } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextStatusBarConfig, FooterConfig } from "./types.js";
import {
	formatSessionTimer,
	formatTokens,
	fgHex,
	pickThresholdHex,
	formatTps,
	formatCacheStats,
	formatCacheHitRate,
	computeTps,
	formatCpuPct,
} from "./formatting.ts";
import { thinkingIcon, thinkingColor } from "../lib/thinking-level.ts";

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

	// ── Init container CPU core count from cgroup v2 cpu.max ──
	// Docker `cpus: N` sets CFS quota via cpu.max (format: "$quota $period").
	// Do NOT use cpuset.cpus.effective — that returns host CPUs, not the Docker limit.
	if (footerConfig.allocatedCpus === 4) {
		try {
			const cpuMax = readFileSync("/sys/fs/cgroup/cpu.max", "utf-8").trim();
			const parts = cpuMax.split(/\s+/);
			if (parts.length >= 2 && parts[0] !== "max") {
				const quota = parseInt(parts[0]!, 10);
				const period = parseInt(parts[1]!, 10);
				if (quota > 0 && period > 0) {
					footerConfig.allocatedCpus = quota / period;
				}
			}
		} catch {
			/* keep default */
		}
	}

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

		// Store re-render trigger so external code (supervisor issue data event
		// listener) can reflect mutated footerConfig without re-installing the
		// entire footer via setFooter(). Avoids race where issue data is set
		// and cleared before setFooter's deferred factory update takes effect.
		footerConfig._requestRender = () => tui.requestRender();

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

				// ── Container resource usage from cgroup v2 ──
				// Throttle cgroup reads to ~1s to avoid flicker during typing.
				// prevCpuTime doubles as last-read timestamp.
				const now = Date.now();
				if (now - footerConfig.prevCpuTime >= 1000) {
					try {
						const usageLine = readFileSync("/sys/fs/cgroup/cpu.stat", "utf-8");
						const m = usageLine.match(/^usage_usec (\d+)/m);
						if (m) {
							const curUsage = parseInt(m[1]!, 10);
							const prevUsage = footerConfig.prevCpuUsage;
							const prevTime = footerConfig.prevCpuTime;

							const memCur = parseInt(
								readFileSync("/sys/fs/cgroup/memory.current", "utf-8").trim(),
								10,
							);
							const memMaxRaw = readFileSync("/sys/fs/cgroup/memory.max", "utf-8").trim();
							const memMax = memMaxRaw === "max" ? 0 : parseInt(memMaxRaw, 10);
							// Subtract reclaimable page cache to match docker stats
							let memUsage = memCur;
							try {
								const memStat = readFileSync("/sys/fs/cgroup/memory.stat", "utf-8");
								const m = memStat.match(/^inactive_file (\d+)/m);
								if (m) {
									const inact = parseInt(m[1]!, 10);
									memUsage = Math.max(0, memCur - inact);
								}
							} catch {
								/* keep memUsage = memCur */
							}

							if (prevUsage > 0 && prevTime > 0 && now - prevTime >= 500 && curUsage >= prevUsage) {
								const deltaCpu = curUsage - prevUsage;
								const cpuPct = Math.min(
									100,
									deltaCpu / (now - prevTime) / footerConfig.allocatedCpus / 10,
								);
								const memPct = memMax > 0 ? Math.round((memUsage / memMax) * 100) : 0;
								footerConfig.containerDisplay.value = `\u{1F40B} CPU ${formatCpuPct(cpuPct)}\u00b7RAM ${memPct}%`;
							}

							footerConfig.prevCpuUsage = curUsage;
							footerConfig.prevCpuTime = now;
						}
					} catch {
						// Not in a cgroup v2 container — skip
					}
				}

				// Use cached display string (updated ~1s by the block above)
				const containerRaw = footerConfig.containerDisplay.value;

				// Combine container, timer, and token display
				if (containerRaw) {
					const parts = [theme.fg("dim", containerRaw)];
					if (timerStr) parts.push(timerStr);
					if (tokenDisplay) parts.push(tokenDisplay);
					rightStr = parts.join(" \u00b7 ");
				} else if (timerStr && tokenDisplay) {
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

					// Truncate title to 50 visible chars with "..." ellipsis
					const truncatedTitle = truncateToWidth(issueTitleVal, 50, "...");
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
