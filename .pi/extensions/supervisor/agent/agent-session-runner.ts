// ─── In-Process Agent Session Runner ──────────────────────────────
// Primary path: runs agent in-process using pi SDK's createAgentSession.
// Falls through to subprocess path if SDK not available or session fails.
//
// Dispatcher: tries in-process SDK runner first, falls back to subprocess.
// Subprocess path retained as backward-compatible fallback.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRunResult, AgentRunState, ParsedAgent } from "../config/types.ts";
import { getModel } from "@earendil-works/pi-ai";
import { agentSessionEventToNormalizedEvent, processNormalizedEvent, forwardNormalizedEventToChat, createForwardChatState } from "../event/adapter.ts";
import { pushLog, createAgentRunState } from "./state-helpers.ts";
import { buildWidgetLines, getWorkingMessage } from "../session/widget.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { getErrorCollector } from "../pipeline/error-collector.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../config/config.ts";
import { extractTextFromContent, extractSummaryLine, formatDuration } from "../lib/formatting.ts";
import { resolveTools } from "../lib/extensions.ts";
import { buildTimeoutNote } from "./runner/cleanup.ts";

// DEFAULT_AGENT_TIMEOUT_MS is imported above from config.ts

// ─── Dynamic import guard ─────────────────────────────────────────
// pi-coding-agent may not be installed at runtime; guard with try/catch.
// Falls through to subprocess path if import fails.

let _createAgentSession: ((opts: any) => Promise<any>) | null = null;
let _SessionManager: { create: (cwd: string) => any; inMemory: () => any } | null = null;
let _SettingsManager: { inMemory: () => any } | null = null;

async function ensureSDK(): Promise<void> {
	if (_createAgentSession) return;
	try {
		const mod: any = await import("@earendil-works/pi-coding-agent");
		_createAgentSession = mod.createAgentSession;
		_SessionManager = mod.SessionManager;
		_SettingsManager = mod.SettingsManager;
	} catch (err: unknown) {
		throw new Error(
			`[@earendil-works/pi-coding-agent] Failed to load SDK: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ─── resolveModel: resolve model string → Model object ────────────
// Uses getModel from @earendil-works/pi-ai to resolve "provider/model-id" strings.
// Throws on failure with clear error message including the model string.

function resolveModel(modelStr: string | undefined): { id: string; provider: string; api: string } {
	if (!modelStr || !modelStr.trim()) {
		throw new Error(`Agent has no model configured (config.model = "${modelStr ?? "undefined"}")`);
	}
	const parts = modelStr.split("/");
	if (parts.length < 2) {
		throw new Error(`Invalid model format "${modelStr}" — expected "provider/model-id"`);
	}
	const provider = parts[0]!;
	const modelId = parts.slice(1).join("/");
	try {
		return getModel(provider as any, modelId);
	} catch (err: unknown) {
		throw new Error(
			`Model "${modelStr}" could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ─── buildToolList: merge agent tools + extension tools ───────────
// Uses resolveTools from lib/extensions.ts (same as subprocess path).
// Returns string array for createAgentSession.

function buildToolList(agent: ParsedAgent, cwd?: string): string[] {
	const rawTools = agent.config.tools || "read,bash,write,edit";
	const toolsStr = resolveTools(rawTools, agent.config.extensions, cwd);
	return toolsStr.split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── buildResourceLoader: create resource loader filtering supervisor ──
// Prevents recursive extension hook registration (the sub-agent session
// must not re-load the supervisor extension).
// Returns undefined to use SDK default which handles extensions via tools list.

// ─── runAgentInProcess (Primary) ──────────────────────────────────

export async function runAgentInProcess(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number | null = DEFAULT_AGENT_TIMEOUT_MS,
	cwd?: string,
	maxToolCalls?: number,
	agentTokenBudget?: number,
	sessionPath?: string,
	pi?: Pick<ExtensionAPI, "sendMessage">,
): Promise<AgentRunResult> {
	const log = getDebugLogger();
	const effectiveCwd = cwd || ctx.cwd || process.cwd();

	// Resolve model before loading SDK (fail fast)
	const modelStr = agent.config.model || "";
	const resolvedModel = resolveModel(modelStr);
	if (!resolvedModel) {
		throw new Error(`Model "${agent.config.model}" could not be resolved for agent "${agent.config.name}"`);
	}

	const agentName = agent.config.name;
	const rawTools = agent.config.tools || "read,bash,write,edit";
	const tools = buildToolList(agent, effectiveCwd);
	const thinkingLevel = agent.config.thinking?.trim() || undefined;

	log.info("agent-runner", `runAgentInProcess: ${agentName}`, {
		effectiveCwd,
		model: modelStr,
		timeoutMs,
		tools: tools.join(","),
		taskLen: task.length,
	});

	ctx.ui.notify(`Running agent: ${agentName}...`, "info");
	ctx.ui.setStatus("supervisor", `Running ${agentName}...`);

	const startedAt = Date.now();
	const state = createAgentRunState(startedAt, maxToolCalls, agentTokenBudget, thinkingLevel);

	const widgetId = `agent-${agentName}`;

	// Hoist cleanup variables
	let flushTimer: NodeJS.Timeout | null = null;
	let timedOut = false;
	// Hold the unsubscribe fn in a ref object: TS control-flow collapses
	// `let x = null` assigned only inside a closure (the body IIFE below) to
	// `never` at outer guards, making the finally cleanup uncallable — an
	// object property keeps its declared type wherever it is read.
	const unsubRef: { current: (() => void) | null } = { current: null };
	let session: any = null;
	let exitError: Error | null = null;
	let deadlineTimer: NodeJS.Timeout | null = null;

	// ── Wall-clock deadline, armed at ENTRY (audit finding #2) ──
	// Model resolution, SDK loading and session creation all count against
	// the configured bound — not just the prompt. The whole setup+prompt body
	// races the deadline, so a hang inside ensureSDK/createAgentSession is
	// bounded exactly like a hung provider call, and the losing side's late
	// rejection is absorbed by Promise.race (no unhandled rejection).
	// null → no deadline (configured 0 = no timeout); 0 → the dispatch
	// deadline already expired → rejects on the next tick (hard 1× bound).
	// The timer is a plainly REF'D setTimeout: while the run hangs, it is the
	// handle that keeps the event loop alive until the deadline fires (an
	// unref'd AbortSignal.timeout would let a bare hang exit the process early).
	const deadlinePromise =
		timeoutMs === null
			? new Promise<never>(() => {})
			: new Promise<never>((_resolve, reject) => {
					deadlineTimer = setTimeout(() => {
						timedOut = true;
						if (session) {
							session.abort();
						}
						reject(new Error(`Agent ${agentName} timed out after ${timeoutMs}ms`));
					}, Math.max(0, timeoutMs));
				});

	const flushWidget = () => {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		try {
			ctx.ui.setWidget(widgetId, buildWidgetLines(state, agentName, modelStr));
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

	try {
		// Setup + prompt race the deadline as ONE body: the SDK load, session
		// creation AND the prompt share the single absolute bound armed above.
		await Promise.race([
			(async () => {
				// Load SDK dynamically
				await ensureSDK();

				// Build session manager (file-backed for session persistence)
				// Use effectiveCwd (not sessionPath) — SessionManager.create expects a cwd,
				// not a file path. The SDK writes the session file to a default location.
				// execute-agent.ts uses result.output for replay instead of replaySessionFile.
				const sessionManager = _SessionManager
					? _SessionManager.create(effectiveCwd)
					: undefined;

				// Create in-process agent session
				const createAgentSession = _createAgentSession!;

				// Guard: verify model resolved before creating session
				if (!resolvedModel) {
					throw new Error(
						`Model "${agent.config.model}" could not be resolved for agent "${agent.config.name}"`,
					);
				}

				session = await createAgentSession({
					model: resolvedModel,
					tools,
					sessionManager,
					thinkingLevel: thinkingLevel || undefined,
					cwd: effectiveCwd,
				});

				// Set up subscription BEFORE calling session.prompt()
				const pending = createForwardChatState();
				unsubRef.current = session.subscribe((event: Record<string, unknown>) => {
					try {
						const normalized = agentSessionEventToNormalizedEvent(event);
						if (!normalized) return;

						const preThinkingText =
							normalized.kind === "thinking_end" ? state.liveThinking.trim() : "";

						const result = processNormalizedEvent(normalized, state, effectiveCwd);
						if (result.workingChange) {
							scheduleFlush();
							const wm = getWorkingMessage(state, agentName);
							ctx.ui.setWorkingMessage(wm ?? undefined);
						}

						// Forward key events as supervisor chat messages
						if (pi) {
							forwardNormalizedEventToChat(
								normalized,
								state,
								pi,
								agentName,
								pending,
								preThinkingText,
								effectiveCwd,
							);
						}
					} catch (parseErr: unknown) {
						const errMsg = String(parseErr).slice(0, 200);
						log.warn("agent-stream", `Event processing error: ${errMsg}`);
						getErrorCollector().push("stream", "warn", `Event processing error: ${errMsg}`);
					}
				});

				// Await the prompt — its rejection (provider error OR the abort()
				// from the deadline firing) settles the body race.
				await session.prompt(task);
			})(),
			deadlinePromise,
		]);
	} catch (err: unknown) {
		exitError = err instanceof Error ? err : new Error(String(err));
	} finally {
		// Cleanup: unsubscribe, dispose session, clear timers
		if (deadlineTimer) {
			clearTimeout(deadlineTimer);
			deadlineTimer = null;
		}
		if (unsubRef.current) {
			unsubRef.current();
			unsubRef.current = null;
		}
		if (session && typeof session.dispose === "function") {
			try {
				session.dispose();
			} catch (disposeErr: unknown) {
				const msg = disposeErr instanceof Error ? disposeErr.message : String(disposeErr);
				log.warn("agent-runner", `Session dispose error for ${agentName}: ${msg}`);
			}
		}
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
	}

	// ── Build result ────────────────────────────────────────
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (state.liveText.trim()) {
		state.textOutputLines.push(state.liveText.trim());
	}
	if (state.liveThinking.trim()) {
		state.thinkingOutputLines.push(state.liveThinking.trim());
	}

	const durationMs = Date.now() - startedAt;
	const textOutput = state.fullLog.join("\n").trim();
	const textOnly = state.textOutputLines.join("\n").trim();
	const rawOutput = textOutput; // No separate raw IO for in-process
	const success = !exitError && !timedOut && !state.budgetExceeded;
	const killed = timedOut;

	if (killed) {
		pushLog(
			state,
			`[Timeout: ${agentName} timed out after ${formatDuration(durationMs)}]`,
		);
	}

	const thinkingOutput =
		state.thinkingOutputLines.length > 0 ? state.thinkingOutputLines.join("\n\n") : undefined;

	const summaryLine = extractSummaryLine(textOutput, success, agentName, new Set(state.toolCalls));

	ctx.ui.setWidget(widgetId, undefined);
	ctx.ui.setWorkingMessage(undefined);
	ctx.ui.setStatus("supervisor", undefined);

	// If session was created and completed, extract messages for output
	let output = rawOutput;
	if (session && session.agent && session.agent.state && session.agent.state.messages) {
		try {
			output = JSON.stringify(session.agent.state.messages);
		} catch {
			// Fall back to rawOutput
		}
	}

	// If in-process failed with a NON-timeout error, propagate to caller for
	// subprocess fallback. Timeout failures return success=false instead.
	if (exitError && !timedOut) {
		throw exitError;
	}

	// Timeout failures are authored into errorOutput (not just textOutput)
	// so buildAgentResultEntry / the pipeline summary table retain them.
	let errorOutput = exitError ? exitError.message : "";
	if (timedOut) {
		const note = buildTimeoutNote({
			agentName,
			configuredTimeoutMs: timeoutMs ?? undefined,
			durationMs,
		});
		errorOutput = errorOutput ? `${errorOutput}\n${note}` : note;
	}

	return {
		output,
		success,
		agentName,
		toolCount: state.toolCount,
		failedToolCount: state.failedToolCount ?? undefined,
		tokenCount: state.tokenCount,
		durationMs,
		textOutput,
		textOnly,
		summaryLine,
		errorOutput,
		thinkingOutput,
		toolCalls: state.toolCalls,
		budgetExceeded: state.budgetExceeded || undefined,
		killReason: timedOut ? "timeout" : state.budgetExceeded ? "budget" : undefined,
		timedOut: timedOut || undefined,
		configuredTimeoutMs: timedOut ? (timeoutMs ?? undefined) : undefined,
	};
}


