// ─── Agent Runner ─────────────────────────────────────────────────
// Dispatcher: tries in-process SDK runner first, falls back to subprocess.
// Subprocess path retained as backward-compatible fallback.
//
// In-process runner lives in agent-session-runner.ts
// Subprocess lifecycle lives in this file (event processing via
// jsonLineToNormalizedEvent + processNormalizedEvent from adapter).

import type { AgentRunResult, AgentRunState, ParsedAgent } from "../config/types.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { resolveTools, resolveExtensionPaths, resolveSkillPaths } from "../lib/extensions.ts";
import { formatDuration, extractSummaryLine } from "../lib/formatting.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../config/config.ts";
import {
	jsonLineToNormalizedEvent,
	processNormalizedEvent,
	filterStderr,
} from "../event/adapter.ts";
import { pushLog } from "./state-helpers.ts";
import { buildWidgetLines, getWorkingMessage } from "../session/widget.ts";
import { runAgentInProcess } from "./session-runner.ts";
import { buildErrorNotificationContext } from "../config/diagnostics.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { getErrorCollector } from "../pipeline/error-collector.ts";

// Re-export DEFAULT_AGENT_TIMEOUT_MS for backward compatibility
export { DEFAULT_AGENT_TIMEOUT_MS } from "../config/config.ts";

// ─── createAgentRunState: shared state initialization ──────────────
// Used by both runAgentSubprocess (agent-runner.ts) and
// runAgentInProcess (agent-session-runner.ts) for consistent state creation.
// Budget params default to 0 (unlimited) for backward compatibility.

export function createAgentRunState(
	startedAt: number,
	maxToolCalls?: number,
	agentTokenBudget?: number,
): AgentRunState {
	return {
		toolCount: 0,
		failedToolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		phase: "idle",
		startedAt,
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: maxToolCalls ?? 0,
		agentTokenBudget: agentTokenBudget ?? 0,
	};
}

// ─── runAgent (Primary: in-process, Fallback: subprocess) ──────────

export async function runAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
	cwd?: string,
	maxToolCalls?: number,
	agentTokenBudget?: number,
): Promise<AgentRunResult> {
	const log = getDebugLogger();
	log.info("agent-runner", `runAgent: ${agent.config.name}`, {
		model: agent.config.model,
		timeoutMs,
		cwd,
		maxToolCalls,
		agentTokenBudget,
		taskLen: task.length,
	});

	// Primary: in-process via SDK
	// Two failure modes:
	//   1. Thrown error (unexpected exception) — caught by catch block
	//   2. Non-success result (watchdog stall, agent error) — checked via result.success
	// Both trigger subprocess fallback for resilience (Phase 3: graceful degradation).
	try {
		const result = await runAgentInProcess(
			agent,
			task,
			ctx,
			pi,
			timeoutMs,
			cwd,
			maxToolCalls,
			agentTokenBudget,
		);

		// Check for non-thrown failures (e.g., watchdog stall, agent error result)
		if (!result.success) {
			const reason = result.summaryLine || result.errorOutput || "unknown error";
			log.warn(
				"agent-runner",
				`[supervisor] In-process runner failed (result.success=false), falling back to subprocess: ${reason}`,
			);
			try {
				const ctx2 = buildErrorNotificationContext("in-process-runner", reason);
				ctx.ui.notify(`In-process runner failed — falling back to subprocess: ${ctx2}`, "warning");
			} catch {
				// notification fallback
			}
			// Chat progress streaming degradation notification
			// Subprocess mode cannot send progress chat messages (no pi.sendMessage access)
			try {
				ctx.ui.notify(
					"Chat progress streaming unavailable in subprocess mode — widget will continue to show live status",
					"warning",
				);
			} catch {
				// notification fallback
			}
			return await runAgentSubprocess(
				agent,
				task,
				ctx,
				timeoutMs,
				cwd,
				maxToolCalls,
				agentTokenBudget,
			);
		}

		log.info("agent-runner", `In-process succeeded for ${agent.config.name}`, {
			success: result.success,
			durationMs: result.durationMs,
			toolCount: result.toolCount,
			tokenCount: result.tokenCount,
			summary: result.summaryLine?.slice(0, 200),
		});

		return result;
	} catch (err: unknown) {
		const errMsg = err instanceof Error ? err.message : String(err);
		log.warn("agent-runner", `In-process runner threw, falling back to subprocess: ${errMsg}`);
		// Show notification with diagnostic context
		try {
			const ctx2 = buildErrorNotificationContext("in-process-runner", errMsg);
			ctx.ui.notify(`In-process runner threw — falling back to subprocess: ${ctx2}`, "warning");
		} catch {
			// notification fallback
		}
		// Chat progress streaming degradation notification
		// Subprocess mode cannot send progress chat messages (no pi.sendMessage access)
		try {
			ctx.ui.notify(
				"Chat progress streaming unavailable in subprocess mode — widget will continue to show live status",
				"warning",
			);
		} catch {
			// notification fallback
		}
		// Fallback: subprocess
		return await runAgentSubprocess(
			agent,
			task,
			ctx,
			timeoutMs,
			cwd,
			maxToolCalls,
			agentTokenBudget,
		);
	}
}

// ─── runAgentSubprocess (Fallback) ─────────────────────────────────

export async function runAgentSubprocess(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
	cwd?: string,
	maxToolCalls?: number,
	agentTokenBudget?: number,
): Promise<AgentRunResult> {
	const log = getDebugLogger();
	const effectiveCwd = cwd || ctx.cwd || process.cwd();
	// Pass worktree path to worktree-sandbox extension for path confinement
	const sandboxEnv = cwd ? { WORKTREE_SANDBOX_PATH: cwd } : {};

	const rawTools = agent.config.tools || "read,bash,write,edit";
	const tools = resolveTools(rawTools, agent.config.extensions, effectiveCwd);
	const model = agent.config.model || "";
	const bareExtPaths = resolveExtensionPaths(agent.config.extensions, effectiveCwd);
	const extFlags: string[] = [];
	const CONTEXT_INFO_PATH = resolvePath(effectiveCwd, ".pi/extensions/context-info.ts");
	if (bareExtPaths.length === 0) {
		// No extensions resolved → just context-info
		extFlags.push("--extension", CONTEXT_INFO_PATH);
	} else {
		for (const p of bareExtPaths) {
			extFlags.push("--extension", p);
		}
		// Auto-inject context-info (dedup if already present in any path)
		if (!bareExtPaths.some((p: string) => p.includes("context-info.ts"))) {
			extFlags.push("--extension", CONTEXT_INFO_PATH);
		}
	}
	const skillPaths = resolveSkillPaths(agent.config.skills, effectiveCwd);

	const args: string[] = [
		"-p",
		"--mode",
		"json",
		task,
		"--system-prompt",
		agent.systemPrompt,
		"--tools",
		tools,
		...extFlags,
		"--no-extensions",
		"--no-skills",
		...skillPaths.flatMap((p) => ["--skill", p]),
		"--no-context-files",
	];
	if (model) args.push("--model", model);
	if (agent.config.thinking && agent.config.thinking.trim()) {
		args.push("--thinking", agent.config.thinking.trim());
	}

	// Warn if task is large enough to risk ARG_MAX (Linux default: 2MB)
	const ARG_MAX_WARN_THRESHOLD = 1_000_000; // 1MB
	const totalArgChars = args.reduce((sum, a) => sum + a.length, 0);
	if (totalArgChars > ARG_MAX_WARN_THRESHOLD) {
		log.warn(
			"agent-runner",
			`Subprocess args large (${totalArgChars} chars) — risk of ARG_MAX overflow for ${agent.config.name}`,
		);
		getErrorCollector().push(
			"runner",
			"warn",
			`Large subprocess args: ${totalArgChars} chars for ${agent.config.name}`,
		);
	}

	log.info("agent-runner", `runAgentSubprocess: ${agent.config.name}`, {
		effectiveCwd,
		model,
		timeoutMs,
		tools,
		skillCount: skillPaths.length,
		taskLen: task.length,
		argChars: totalArgChars,
	});

	const widgetId = `agent-${agent.config.name}`;
	const agentName = agent.config.name;
	ctx.ui.notify(`Running agent: ${agentName}...`, "info");
	ctx.ui.setStatus("supervisor", `Running ${agentName}...`);

	const startedAt = Date.now();

	const state = createAgentRunState(startedAt, maxToolCalls, agentTokenBudget);

	log.info("agent-runner", `Subprocess spawn: ${agentName}`, {
		pid: process.pid,
		startedAt,
	});

	return new Promise((resolve) => {
		const child = spawn("/usr/bin/pi", args, {
			cwd: effectiveCwd,
			env: { ...process.env, PI_NO_COLOR: "1", ...sandboxEnv },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
		});

		log.info("agent-runner", `Subprocess spawned: ${agentName}`, { childPid: child.pid });

		const MAX_RAW_STDOUT = 500_000;
		let rawStdout = "";
		let stderr = "";
		let jsonBuffer = "";
		let childExited = false;

		let flushTimer: NodeJS.Timeout | null = null;

		const flushWidget = () => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			try {
				ctx.ui.setWidget(widgetId, buildWidgetLines(state, agentName, model));
			} catch (renderErr: unknown) {
				const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
				log.error("agent-runner", `Widget render error for ${agentName}: ${msg}`);
				getErrorCollector().push("runner", "warn", `Widget render error for ${agentName}: ${msg}`);
			}
		};

		const scheduleFlush = () => {
			if (!flushTimer) {
				flushTimer = setTimeout(flushWidget, 300);
			}
		};

		// Gentle 2s heartbeat — keeps terminal alive during quiet periods.
		// Original freeze was from requestRender(true) + 5s interval, not heartbeat itself.
		// Without heartbeat, terminal stops rendering between events — "stuck until keystroke".
		// flushWidget calls setWidget which calls requestRender (coalesced by TUI to 16ms).
		// Try-catch prevents uncaught exceptions from killing the interval.
		const heartbeatTimer = setInterval(() => {
			try {
				if (!flushTimer) flushWidget();
			} catch (hbErr: unknown) {
				const msg = hbErr instanceof Error ? hbErr.message : String(hbErr);
				getErrorCollector().push("runner", "warn", `heartbeat error for ${agentName}: ${msg}`);
			}
		}, 2000);

		// Event-driven flush at 300ms debounce + 2s heartbeat.
		// Try-catch prevents uncaught exceptions from breaking the JSON stream processing.
		// Inlines the former processJsonLine() logic from deleted agent/stream.ts:
		//   - jsonLineToNormalizedEvent has inner try-catch, returns null on parse fail
		//   - outer catch preserves error reporting (getDebugLogger.warn +
		//     getErrorCollector.push) that was formerly inside processJsonLine
		const handleLine = (line: string) => {
			try {
				if (!line.trim()) return;
				const normalized = jsonLineToNormalizedEvent(line);
				if (!normalized) return;
				const result = processNormalizedEvent(normalized, state);
				if (result.workingChange) {
					scheduleFlush();
					const wm = getWorkingMessage(state, agentName);
					ctx.ui.setWorkingMessage(wm ?? undefined);
				}
				// Budget exceeded — kill subprocess to prevent further turns
				if (state.budgetExceeded && !childExited) {
					child.kill("SIGTERM");
				}
			} catch (parseErr: unknown) {
				const preview = line.length > 200 ? line.slice(0, 200) + "…" : line;
				const errMsg = String(parseErr).slice(0, 200);
				getDebugLogger().warn("agent-stream", `JSON parse error: ${errMsg}`, { preview });
				if (line.trim()) {
					getErrorCollector().push("stream", "warn", `JSON parse error: ${errMsg}`);
				}
			}
		};

		child.stdout.on("data", (data: Buffer) => {
			const chunk = data.toString();
			if (rawStdout.length + chunk.length > MAX_RAW_STDOUT) {
				const keep = MAX_RAW_STDOUT - chunk.length;
				rawStdout = rawStdout.slice(-Math.max(keep, 0)) + chunk;
			} else {
				rawStdout += chunk;
			}
			jsonBuffer += chunk;
			const lines = jsonBuffer.split("\n");
			jsonBuffer = lines.pop() || "";
			for (const line of lines) handleLine(line);
		});

		child.stderr.on("data", (data: Buffer) => {
			const chunk = data.toString();
			if (stderr.length + chunk.length <= MAX_RAW_STDOUT) {
				stderr += chunk;
			}
		});

		// ── Bug 3 fix: Proper child reaping ──
		// Register 'exit' to reap child process entry (prevents zombie).
		// 'close' fires after stdio drains — use it for final resolve with code/signal.
		// Guard with resolved flag to prevent double-resolve.
		let resolved = false;

		const doResolve = (code: number | null, signal: string | null) => {
			if (resolved) return;
			resolved = true;

			if (jsonBuffer.trim()) handleLine(jsonBuffer);
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			clearInterval(heartbeatTimer);
			if (state.liveText.trim()) {
				state.textOutputLines.push(state.liveText.trim());
			}
			if (state.liveThinking.trim()) {
				state.thinkingOutputLines.push(state.liveThinking.trim());
			}

			const durationMs = Date.now() - startedAt;
			const textOutput = state.fullLog.join("\n").trim();
			const textOnly = state.textOutputLines.join("\n").trim();
			const rawOutput = rawStdout + (stderr ? "\n[STDERR]\n" + stderr : "");
			const killed = signal !== null;
			const success = code === 0 && !killed;
			if (killed) {
				pushLog(
					state,
					`[Timeout: ${agentName} killed by ${signal} after ${formatDuration(durationMs)}]`,
				);
			}

			const thinkingOutput =
				state.thinkingOutputLines.length > 0 ? state.thinkingOutputLines.join("\n\n") : undefined;

			const summaryLine = extractSummaryLine(textOutput, success, agentName);
			const filteredStderr = filterStderr(stderr);

			ctx.ui.setWidget(widgetId, undefined);
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.setStatus("supervisor", undefined);

			resolve({
				output: rawOutput,
				success,
				agentName,
				toolCount: state.toolCount,
				failedToolCount: state.failedToolCount ?? undefined,
				tokenCount: state.tokenCount,
				durationMs,
				textOutput,
				textOnly,
				summaryLine,
				errorOutput: filteredStderr,
				thinkingOutput,
				budgetExceeded: state.budgetExceeded || undefined,
			});
		};

		// 'exit' reaps process table entry — prevents zombie
		child.on("exit", () => {
			childExited = true;
		});

		// 'close' fires after stdio drains — resolve with actual code/signal
		child.on("close", (code, signal) => {
			childExited = true;
			doResolve(code, signal);
		});

		child.on("error", (err) => {
			const spawnError = `Subprocess spawn error: ${err.message}`;
			log.error("agent-runner", spawnError, { agentName: agent.config.name });
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			clearInterval(heartbeatTimer);
			ctx.ui.setWidget(widgetId, undefined);
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.setStatus("supervisor", undefined);
			resolve({
				output: `Failed to start pi: ${err.message}`,
				success: false,
				agentName: agent.config.name,
				toolCount: 0,
				failedToolCount: undefined,
				tokenCount: 0,
				durationMs: Date.now() - startedAt,
				textOutput: "",
				textOnly: "",
				summaryLine: `Failed to start: ${err.message}`,
				errorOutput: err.message,
			});
		});
	});
}
