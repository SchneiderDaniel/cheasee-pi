/**
 * session-advice — Session advice extension
 *
 * Generates .advice.md alongside .jsonl session files.
 * Detects waste signals from session data, uses LLM to generate
 * actionable advice. Injects past lessons into agent system prompt.
 *
 * Detection logic in session-analyzer.ts (pure).
 * LLM advice generation + signal review in llm-advisor.ts.
 * Report pipeline in advice-pipeline.ts.
 * Symlink management in symlink-manager.ts.
 * Fix constants in advice-pipeline.ts.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { createExtensionStateStore } from "../lib/extension-state.ts";
import type { ExtensionStateStore } from "../lib/extension-state.ts";

// ── Shared extension state store (replaces duplicated writeExtState) ──
const extState: ExtensionStateStore = createExtensionStateStore(
	".pi/state/session-extensions.json",
);

export function getSessionAdviceState(): boolean {
	return extState.getKey("advice") ?? true;
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AdvicePipeline } from "./advice-pipeline.ts";
import {
	backfillMissingAdvice,
	handleShutdown,
	createGhIssue,
	createSignalIssues,
	generateAdviceReport,
	writeAdvice,
} from "./advice-pipeline.ts";
import type { SystemPromptOptions } from "./llm-advisor.ts";
import { analyzeSession } from "./session-analyzer.ts";
import { parseJsonlFile } from "./jsonl-parser.ts";

// ── Arg parsing helpers ──

/**
 * Split a raw command argument string into an argv-like array,
 * handling single and double quoted strings.
 */
export function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === " " && !inSingle && !inDouble) {
			if (current.length > 0) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current.length > 0) args.push(current);
	return args;
}

/**
 * Simple argument parser: handles --flag value and positional args.
 * Used as fallback when parseArgs from the pi package is not available.
 */
type PiArgs = {
	messages: string[];
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
};

/** Lazy-loaded reference to parseArgs from the pi package. */
let _parseArgsFn: ((argv: string[]) => PiArgs) | null = null;
let _parseArgsChecked = false;

async function getParseArgsFn(): Promise<((argv: string[]) => PiArgs) | null> {
	if (_parseArgsChecked) return _parseArgsFn;
	_parseArgsChecked = true;
	try {
		const mod = await import("@earendil-works/pi-coding-agent");
		if (typeof (mod as any).parseArgs === "function") {
			_parseArgsFn = (mod as any).parseArgs as (argv: string[]) => PiArgs;
		}
	} catch {
		// Not available — keep null
	}
	return _parseArgsFn;
}

function parseCommandArgsSimple(argv: string[]): PiArgs {
	const messages: string[] = [];
	const unknownFlags = new Map<string, boolean | string>();
	const diagnostics: Array<{ type: "warning" | "error"; message: string }> = [];

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const flagName = arg.slice(2);
			if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
				unknownFlags.set(flagName, argv[i + 1]);
				i += 2;
			} else {
				unknownFlags.set(flagName, true);
				i += 1;
			}
		} else {
			messages.push(arg);
			i += 1;
		}
	}

	return { messages, unknownFlags, diagnostics };
}

const pipeline = new AdvicePipeline();

export {
	generateAdviceReport,
	writeAdvice,
	backfillMissingAdvice,
	handleShutdown,
	createGhIssue,
	createSignalIssues,
};

export default function (pi: ExtensionAPI): void {
	let enabled = true;
	extState.setKey("advice", true);
	extState.saveState().catch(() => {}); // Fire-and-forget on init

	/** Persist the current enabled state to disk (best-effort, fire-and-forget). */
	function syncAdviceState() {
		extState.setKey("advice", enabled);
		extState.saveState().catch((err) => {
			// Can't notify without ctx here — best effort
		});
	}

	pi.registerCommand("session-advice", {
		description:
			"Toggle session advice on/off, or generate report. Usage: /session-advice [on|off|report]",

		handler: async (args, ctx) => {
			// Parse arguments using parseArgs (from pi >= 0.78.0) or fallback
			const argv = splitArgs(args ?? "");
			const parseArgsFn = await getParseArgsFn();
			const parsed = parseArgsFn ? parseArgsFn(argv) : parseCommandArgsSimple(argv);
			const cmd = parsed.messages[0]?.toLowerCase() ?? "";

			if (cmd === "report") {
				// Check project trust before generating report
				const isTrusted =
					typeof (ctx as any).isProjectTrusted === "function"
						? (ctx as any).isProjectTrusted()
						: true;
				if (!isTrusted) {
					ctx.ui.notify("Project not trusted. Cannot generate session advice report.", "warning");
					return;
				}

				const cwd = ctx.sessionManager?.getCwd();
				if (!cwd) {
					ctx.ui.notify("Cannot determine project directory.", "error");
					return;
				}
				const sessionsDir = path.resolve(cwd, ".pi", "sessions");
				if (!fs.existsSync(sessionsDir)) {
					ctx.ui.notify(`No sessions directory: ${sessionsDir}`, "error");
					return;
				}

				ctx.ui.notify("Generating session waste report...", "info");

				const model = ctx.model;
				const modelRegistry = ctx.modelRegistry;

				// Try to get system prompt options for advice enrichment
				let systemPromptOptions: SystemPromptOptions | undefined;
				try {
					const spo =
						typeof (ctx as any).getSystemPromptOptions === "function"
							? (ctx as any).getSystemPromptOptions()
							: undefined;
					if (spo) {
						systemPromptOptions = {
							selectedTools: spo.selectedTools,
							contextFiles: spo.contextFiles,
							skills: spo.skills,
						};
					}
				} catch {
					// Not available — proceed without
				}

				const { markdown, reportPath, report } = await pipeline.generateReport(
					sessionsDir,
					model,
					modelRegistry,
					systemPromptOptions,
				);

				ctx.ui.notify(`Report written: ${reportPath}`, "info");

				// Helper to resolve repo from settings
				function getRepo(): string | null {
					const settingsPath = path.resolve(cwd, ".pi", "settings.json");
					try {
						const raw = fs.readFileSync(settingsPath, "utf-8");
						const settings = JSON.parse(raw);
						return settings?.supervisor?.repo ?? null;
					} catch {
						return null;
					}
				}

				// Guard confirm dialogs behind hasUI
				const hasUI = ctx.hasUI;

				// Ask about report GitHub issue (only with UI)
				if (hasUI) {
					const createReportIssue = await ctx.ui.confirm(
						"Create GitHub issue from report?",
						"Create a GitHub issue from the waste report in the project repo (.pi/settings.json → supervisor.repo)?",
					);

					if (createReportIssue) {
						const repo = getRepo();
						if (!repo) {
							ctx.ui.notify("No repo found in .pi/settings.json (supervisor.repo)", "error");
						} else {
							ctx.ui.notify(`Creating issue in ${repo}...`, "info");
							try {
								const wasteMatch = markdown.match(/\| Total waste \|.*?\(([\d.]+)%\)/);
								const wastePct = wasteMatch ? wasteMatch[1] : "?";
								const date = new Date().toISOString().slice(0, 10);
								const title = `Session Waste Report — ${date} (${wastePct}% waste)`;
								const result = createGhIssue(repo, title, markdown, sessionsDir);
								ctx.ui.notify(`Issue created: ${result}`, "info");
							} catch (err) {
								ctx.ui.notify(`Failed to create issue: ${(err as Error).message}`, "error");
							}
						}
					}
				}

				// Ask about signal review issues (if review ran) — only with UI
				if (hasUI && report.review) {
					const hasRemovals = report.review.verdicts.some((v) => v.verdict === "remove");
					const hasAdditions = report.review.newSignals.length > 0;

					if (hasRemovals || hasAdditions) {
						const createSignalIssuesConfirm = await ctx.ui.confirm(
							"Create signal review issues?",
							`${hasRemovals ? "Detector removals proposed. " : ""}${hasAdditions ? "New detector proposals. " : ""}Create GitHub issues for detector changes?`,
						);

						if (createSignalIssuesConfirm) {
							const repo = getRepo();
							if (!repo) {
								ctx.ui.notify("No repo found in .pi/settings.json (supervisor.repo)", "error");
							} else {
								const urls = createSignalIssues(
									repo,
									report.review,
									report.totalSessions,
									sessionsDir,
								);
								if (urls.length > 0) {
									ctx.ui.notify(`Signal issues created: ${urls.join(", ")}`, "info");
								} else {
									ctx.ui.notify("No signal issues were created.", "info");
								}
							}
						}
					}
				}

				// Ask about cleanup — only with UI
				if (hasUI) {
					const clean = await ctx.ui.confirm(
						"Clean sessions?",
						"Delete all session files (.jsonl, .md, .metadata.json, .advice.md) from .pi/sessions/?\n\nThis keeps the report but removes raw session data.",
					);

					if (clean) {
						let deleted = 0;
						try {
							const files = fs.readdirSync(sessionsDir);
							for (const f of files) {
								if (
									f === "latest.jsonl" ||
									f === "latest.md" ||
									f === "latest.metadata.json" ||
									f === "latest.advice.md" ||
									f === "advice-report.md" ||
									f.startsWith(".")
								)
									continue;
								const ext = f.split(".").pop();
								if (ext === "jsonl" || ext === "md" || ext === "json") {
									fs.unlinkSync(path.join(sessionsDir, f));
									deleted++;
								}
							}
						} catch (err) {
							ctx.ui.notify(`Cleanup failed: ${(err as Error).message}`, "error");
							return;
						}
						ctx.ui.notify(`Cleaned ${deleted} session files. Report kept.`, "info");
					}
				}

				return;
			}

			// Toggle
			if (cmd === "on") enabled = true;
			else if (cmd === "off") enabled = false;
			else enabled = !enabled;
			syncAdviceState();
			ctx.ui.notify(`Session advice: ${enabled ? "ON" : "OFF"} (applies to next session)`, "info");
		},
	});

	/** Check if project is trusted using ctx.isProjectTrusted (pi >= 0.79.1) or fallback to true. */
	function isProjectTrusted(ctx: object): boolean {
		const ext = ctx as Record<string, unknown>;
		return typeof ext.isProjectTrusted === "function"
			? (ext.isProjectTrusted as () => boolean)()
			: true;
	}

	// ── Recovery: generate advice for past sessions missing .advice.md ──

	pi.on("session_start", async (_event, ctx) => {
		syncAdviceState();
		if (!enabled) return;

		// Skip if project not trusted
		if (!isProjectTrusted(ctx as unknown as object)) return;

		const sm = ctx.sessionManager;
		const cwd = sm.getCwd();
		if (!cwd) return;

		const sessionsDir = path.resolve(cwd, ".pi", "sessions");
		if (!fs.existsSync(sessionsDir)) return;

		await backfillMissingAdvice(sessionsDir, sm.getSessionFile(), ctx.model, ctx.modelRegistry);
	});

	// ── Generate advice for current closing session ──

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!enabled) return;

		// Skip if project not trusted
		if (!isProjectTrusted(ctx as unknown as object)) return;

		await handleShutdown(ctx.sessionManager.getSessionFile(), ctx.model, ctx.modelRegistry);
	});

	// ── before_agent_start: inject past session waste lessons into system prompt ──

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;

		// Skip if project not trusted
		if (!isProjectTrusted(ctx as unknown as object)) {
			ctx.ui.notify("Project not trusted. Skipping lesson injection.", "warning");
			return;
		}

		const cwd = process.cwd();
		const latestAdvicePath = path.resolve(cwd, ".pi", "sessions", "latest.advice.md");
		if (!fs.existsSync(latestAdvicePath)) return;

		try {
			const adviceContent = fs.readFileSync(latestAdvicePath, "utf-8");
			if (!adviceContent || adviceContent.includes("Clean session")) return;

			const actions: string[] = [];
			const lines = adviceContent.split("\n");
			let inActions = false;
			let actionCount = 0;

			for (const line of lines) {
				if (line.includes("### Recommended Actions")) {
					inActions = true;
					continue;
				}
				if (line.includes("### Waste Signals")) {
					inActions = false;
					continue;
				}
				if (inActions && line.startsWith("-")) {
					const actionText = line.replace(/^- [🔴🟡🟢]\s*\*\*(.*?)\*\*.*$/, "$1").trim();
					if (actionText && actionText.length > 10 && actionCount < 3) {
						actions.push(actionText);
						actionCount++;
					}
				}
			}

			if (actions.length === 0) {
				for (const line of lines) {
					if (line.startsWith("- `") && actionCount < 3) {
						const detail = line.slice(0, 200);
						actions.push(detail);
						actionCount++;
					}
				}
			}

			if (actions.length === 0) return;

			// Cross-reference waste patterns against systemPromptOptions
			// Inspect event.systemPromptOptions for tool config context
			const spo = event.systemPromptOptions;
			if (spo?.selectedTools && spo.selectedTools.length > 12) {
				// If many tools configured but only a few used, suggest pruning
				const toolCount = spo.selectedTools.length;
				// actions already extracted from advice content
				const pruneSuggestion = `  - Consider pruning unused tools from active set (${toolCount} tools configured)`;
				if (actions.length < 3) {
					actions.push(pruneSuggestion);
				}
			}

			const top3 = actions
				.slice(0, 3)
				.map((a) => `  - ${a}`)
				.join("\n");
			const lessonsBlock = `\n\n⚠️ Past Session Lessons (from session advisor)\n${top3}\n`;

			return {
				systemPrompt: event.systemPrompt + lessonsBlock,
			};
		} catch {
			// Silently fail
		}
	});
}
