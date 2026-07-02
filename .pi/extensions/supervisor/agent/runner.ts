// ─── Agent Runner ─────────────────────────────────────────────────
// Dispatcher: tries in-process SDK runner first, falls back to subprocess.
// Subprocess path retained as backward-compatible fallback.
//
// In-process runner lives in agent-session-runner.ts
// Subprocess lifecycle lives in this file (event processing via
// jsonLineToNormalizedEvent + processNormalizedEvent from adapter).

import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRunResult, AgentRunState, ParsedAgent } from "../config/types.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { resolveTools, resolveExtensionPaths, resolveSkillPaths } from "../lib/extensions.ts";
import {
	formatDuration,
	extractSummaryLine,
} from "../lib/formatting.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../config/config.ts";
import {
	jsonLineToNormalizedEvent,
	processNormalizedEvent,
	filterStderr,
	forwardNormalizedEventToChat,
	createForwardChatState,
} from "../event/adapter.ts";
import { pushLog, createAgentRunState } from "./state-helpers.ts";
import { buildWidgetLines, getWorkingMessage } from "../session/widget.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { getErrorCollector } from "../pipeline/error-collector.ts";
import { runAgentInProcess } from "./agent-session-runner.ts";

// Re-export DEFAULT_AGENT_TIMEOUT_MS for backward compatibility
export { DEFAULT_AGENT_TIMEOUT_MS } from "../config/config.ts";

// ─── runAgent — in-process first, subprocess fallback ────────────
// Dispatcher that tries the in-process SDK runner first.
// Falls back to subprocess on exception or unsuccessful result.

export async function runAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
	cwd?: string,
	maxToolCalls?: number,
	agentTokenBudget?: number,
	sessionPath?: string,
	pi?: Pick<ExtensionAPI, "sendMessage">,
): Promise<AgentRunResult> {
	try {
		const result = await runAgentInProcess(
			agent,
			task,
			ctx,
			timeoutMs,
			cwd,
			maxToolCalls,
			agentTokenBudget,
			sessionPath,
			pi,
		);
		// Fall back on unsuccessful result too
		if (!result.success) {
			console.warn(
				"[supervisor] In-process runner failed (result.success=false), falling back to subprocess",
			);
			return await runAgentSubprocess(
				agent,
				task,
				ctx,
				timeoutMs,
				cwd,
				maxToolCalls,
				agentTokenBudget,
				sessionPath,
				pi,
			);
		}
		return result;
	} catch (err: unknown) {
		console.warn(
			"[supervisor] In-process runner failed (result.success=false), falling back to subprocess",
		);
		// Use `return await` to catch synchronous throws from subprocess runner
		return await runAgentSubprocess(
			agent,
			task,
			ctx,
			timeoutMs,
			cwd,
			maxToolCalls,
			agentTokenBudget,
			sessionPath,
			pi,
		);
	}
}



// ─── buildSubprocessArgs: assemble CLI args for pi --mode json ──────
// Extracted from runAgentSubprocess for reuse in executeAgent.
// Used by both runAgentSubprocess and the slimmed subagent/index.ts.
//
// SAFE_TASK_CHARS: max chars before we spill task to a temp file and
// pass @file instead of raw CLI arg. Linux ARG_MAX is typically 2MB.
// We keep well below that by spilling at 1.2M chars (remaining ~800KB
// for other args, env, execve overhead).
// ponytail: temp file cleanup deferred to OS (/tmp cleanup on reboot).

const SAFE_TASK_CHARS = 1_200_000;

function buildSubprocessArgs(
	agent: ParsedAgent,
	task: string,
	effectiveCwd: string,
	sessionPath?: string,
): string[] {
	const rawTools = agent.config.tools || "read,bash,write,edit";
	const tools = resolveTools(rawTools, agent.config.extensions, effectiveCwd);
	const model = agent.config.model || "";
	const bareExtPaths = resolveExtensionPaths(agent.config.extensions, effectiveCwd);
	const extFlags = bareExtPaths.flatMap((p) => ["--extension", p]);
	const skillPaths = resolveSkillPaths(agent.config.skills, effectiveCwd);

	// If task is large, write to temp file and use @file to bypass ARG_MAX
	const taskArg =
		task.length > SAFE_TASK_CHARS
			? (() => {
					const tmpDir = mkdtempSync(join(tmpdir(), "pi-task-"));
					const taskFile = join(tmpDir, "task.txt");
					writeFileSync(taskFile, task, "utf-8");
					return `@${taskFile}`;
				})()
			: task;

	const args: string[] = [
		"-p",
		"--mode",
		"json",
		taskArg,
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
	if (sessionPath) {
		args.push("--session", sessionPath);
	}
	return args;
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
	sessionPath?: string,
	pi?: Pick<ExtensionAPI, "sendMessage">,
): Promise<AgentRunResult> {
	const log = getDebugLogger();
	const effectiveCwd = cwd || ctx.cwd || process.cwd();
	// Pass worktree path to worktree-sandbox extension for path confinement
	const sandboxEnv = cwd ? { WORKTREE_SANDBOX_PATH: cwd } : {};

	const args = buildSubprocessArgs(agent, task, effectiveCwd, sessionPath);
	const model = agent.config.model || "";

	// Recompute for logging (also computed inside buildSubprocessArgs)
	const rawTools = agent.config.tools || "read,bash,write,edit";
	const tools = resolveTools(rawTools, agent.config.extensions, effectiveCwd);
	const skillPaths = resolveSkillPaths(agent.config.skills, effectiveCwd);

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

	const thinkingLevel = agent.config.thinking?.trim() || undefined;
	const state = createAgentRunState(startedAt, maxToolCalls, agentTokenBudget, thinkingLevel);

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
		const pending = createForwardChatState();
		const handleLine = (line: string) => {
			try {
				if (!line.trim()) return;
				const normalized = jsonLineToNormalizedEvent(line);
				if (!normalized) return;
				// ponytail: capture pre-processing state for events that mutate it.
				// processNormalizedEvent clears state.liveThinking on thinking_end,
				// so we save it before forwarding below.
				const preThinkingText = normalized.kind === "thinking_end" ? state.liveThinking.trim() : "";
				const result = processNormalizedEvent(normalized, state);
				if (result.workingChange) {
					scheduleFlush();
					const wm = getWorkingMessage(state, agentName);
					ctx.ui.setWorkingMessage(wm ?? undefined);
				}
				// Forward key events as supervisor chat messages
				if (pi) {
					forwardNormalizedEventToChat(normalized, state, pi, agentName, pending, preThinkingText);
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
				thinkingLevel: state.thinkingLevel,
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
