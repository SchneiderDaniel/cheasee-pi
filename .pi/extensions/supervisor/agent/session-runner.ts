// ─── Agent Session Runner (In-Process SDK) ────────────────────────
// Runs agents in-process via createAgentSession() from the pi SDK.
// Replaces subprocess spawn for complete output capture.
//
// Responsibilities:
//  1. Resolve model from agent config string via ModelRegistry + AuthStorage
//  2. Build tool list: built-in + extension tools
//  3. Create AgentSession with SessionManager.inMemory()
//  4. Subscribe to session events → update TUI widget + collect output
//  5. Run session.prompt(task) with timeout
//  6. Extract complete messages → build AgentRunResult (untruncated)
//  7. Always dispose session on completion

import type { ParsedAgent, AgentRunResult, AgentRunState } from "../config/types.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	SessionManager,
	SettingsManager,
	DefaultResourceLoader,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { resolveExtensionPaths } from "../lib/extensions.ts";
import { formatDuration, extractSummaryLine } from "../lib/formatting.ts";
import { pushLog } from "./stream.ts";
import { buildWidgetLines, getWorkingMessage } from "../session/widget.ts";
import { resolveModel, buildToolList } from "../session/model.ts";
// Widget-based progress replaces sendAgentProgressMessage/clearAgentProgressMessage
// which were removed from notifications.ts. Widget lifecycle is handled inline
// via ctx.ui.setWidget() with buildWidgetLines() — matching session-runner's existing pattern.
import { processSessionEvent } from "../event/session-events.ts";
import { buildAgentRunResult } from "../session/result.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../config/config.ts";
import { createAgentRunState } from "./runner.ts";
import { calculateIdleWarning, buildErrorNotificationContext } from "../config/diagnostics.ts";
import { createWatchdog } from "../lib/watchdog.ts";
import type { WatchdogHandle } from "../lib/watchdog.ts";
import { createInstrumenter } from "../lib/instrumentation.ts";
import type { InstrumenterHandle } from "../lib/instrumentation.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { getErrorCollector } from "../pipeline/error-collector.ts";

// ─── Main: runAgentInProcess ────────────────────────────────────────

/**
 * Run an agent in-process via the pi SDK.
 *
 * Creates an ephemeral AgentSession, subscribes to events for live TUI updates,
 * runs the prompt with timeout, and returns a complete untruncated AgentRunResult.
 *
 * Always disposes the session on completion (success, timeout, or error).
 */
export async function runAgentInProcess(
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
	const effectiveCwd = cwd || ctx.cwd || process.cwd();
	const agentName = agent.config.name;
	const widgetId = `agent-${agentName}`;

	log.info("agent-session-runner", `runAgentInProcess: ${agentName}`, {
		effectiveCwd,
		model: agent.config.model,
		timeoutMs,
		maxToolCalls,
		agentTokenBudget,
		taskLen: task.length,
	});

	// Set sandbox env var for worktree confinement extension (restored in finally)
	const _prevSandboxEnv = process.env.WORKTREE_SANDBOX_PATH;
	if (cwd) {
		process.env.WORKTREE_SANDBOX_PATH = cwd;
	} else {
		delete process.env.WORKTREE_SANDBOX_PATH;
	}

	ctx.ui.notify(`Running agent (in-process): ${agentName}...`, "info");
	ctx.ui.setStatus("supervisor", `Running ${agentName}...`);

	const startedAt = Date.now();

	const state = createAgentRunState(startedAt, maxToolCalls, agentTokenBudget);

	// Hoist cleanup variables so they're accessible in try, catch, and finally
	let flushTimer: NodeJS.Timeout | null = null;
	let heartbeatTimer: NodeJS.Timeout | null = null;

	// ── Diagnostics: event tracking, watchdog, instrumentation ──
	// Track last event time for idle detection and watchdog liveness
	let lastEventTime = Date.now();

	// Create watchdog to detect stalled event delivery (120s = 120_000ms timeout, 10s check interval)
	// Increased from 30s because reasoning models (deepseek-v4-flash with thinking:high)
	// can take >30s to emit first token for large audit prompts with many tools/skills.
	const WATCHDOG_TIMEOUT_MS = 120_000;
	const WATCHDOG_CHECK_INTERVAL_MS = 5_000;
	const IDLE_WARNING_THRESHOLD_MS = 15_000;

	let watchdogFired = false;
	let watchdogHandle: WatchdogHandle | undefined;
	let instrumenter: InstrumenterHandle | undefined;

	// ── Bug 2 fix: Model resolution guard ──
	// Throw when model can't be resolved instead of silently falling back
	// to supervisor default. This prevents token misattribution and model
	// confusion (GH #525).
	const modelInfo = await resolveModel(agent.config.model || "");
	let resolvedModel: ReturnType<typeof getModel> | undefined;
	if (modelInfo) {
		try {
			resolvedModel = getModel(
				modelInfo.provider as Parameters<typeof getModel>[0],
				modelInfo.modelId as Parameters<typeof getModel>[1],
			);
		} catch (getModelErr: unknown) {
			const getModelMsg = getModelErr instanceof Error ? getModelErr.message : String(getModelErr);
			log.error(
				"agent-session-runner",
				`getModel threw for ${modelInfo?.provider}/${modelInfo?.modelId}: ${getModelMsg}`,
			);
			throw new Error(
				`Agent ${agentName}: model "${modelInfo?.provider}/${modelInfo?.modelId}" not available — ` +
					`getModel failed: ${getModelMsg}`,
			);
		}
	}
	if (!resolvedModel) {
		const modelStr = agent.config.model || "(not configured)";
		log.error("agent-session-runner", `Model not resolved for ${agentName}: ${modelStr}`);
		throw new Error(
			`Agent ${agentName}: model "${modelStr}" cannot be resolved — ` +
				`check that the provider/model is configured and credentials are available`,
		);
	}

	// Build tool list
	const tools = buildToolList(agent, effectiveCwd);
	log.debug("agent-session-runner", `Built ${tools.length} tools for ${agentName}`, {
		toolNames: tools.map((t: any) => t.name || "?"),
	});

	// Resolve extension paths for resource loader.
	// Use supervisor cwd (ctx.cwd) so brand-new extensions like worktree-sandbox
	// are found even before they're committed to the worktree branch.
	const extPaths = resolveExtensionPaths(agent.config.extensions, ctx.cwd);

	let session;
	let unsubscribe: (() => void) | undefined;

	try {
		// Create resource loader with system prompt override and extension paths
		const resourceLoader = new DefaultResourceLoader({
			cwd: effectiveCwd,
			agentDir: getAgentDir(),
			settingsManager: SettingsManager.inMemory(),
			systemPromptOverride: () => agent.systemPrompt,
			additionalExtensionPaths: extPaths.length > 0 ? extPaths : undefined,
			noExtensions: true,
		});
		await resourceLoader.reload();

		const sessionManager = SessionManager.inMemory(effectiveCwd);
		const settingsManager = SettingsManager.inMemory();

		const sessionResult = await createAgentSession({
			cwd: effectiveCwd,
			sessionManager,
			resourceLoader,
			settingsManager,
			tools: tools.length > 0 ? tools : undefined,
			noTools: tools.length > 0 ? "builtin" : undefined,
			model: resolvedModel,
			// Pass thinking level from agent config so in-process session matches
			// subprocess behavior (which passes --thinking <level>). Without this,
			// the session uses default thinking level from settings, which may differ
			// from what the agent requires for correct behavior.
			thinkingLevel:
				(agent.config.thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh") ||
				undefined,
		});
		session = sessionResult.session;

		// ── Create watchdog and instrumenter ──
		instrumenter = createInstrumenter();

		watchdogHandle = createWatchdog({
			timeoutMs: WATCHDOG_TIMEOUT_MS,
			checkIntervalMs: WATCHDOG_CHECK_INTERVAL_MS,
			onTimeout: async (elapsedMs: number) => {
				watchdogFired = true;
				const elapsedSec = Math.round(elapsedMs / 1000);
				log.warn(
					"agent-session-runner",
					`Watchdog timeout — no events for ${elapsedSec}s, aborting ${agentName}`,
				);
				const msg = `[supervisor] No events for ${elapsedSec}s — agent may be stuck`;
				getErrorCollector().push(
					"session-runner",
					"warn",
					`No events for ${elapsedSec}s — agent may be stuck`,
				);
				ctx.ui.notify(`No agent events for ${elapsedSec}s — aborting stuck session`, "warning");
				try {
					await session!.abort();
				} catch {
					// session already handled
				}
			},
		});

		// ── Live widget via string array ──
		// Uses ctx.ui.setWidget() with a string array (lighter than Component factory).
		// buildWidgetLines builds ≤20 lines from state (log entries, stats, phase info).
		// No requestRender call — avoids forced synchronous re-render
		// that freezes terminal input (Bug: terminal freeze fix).
		const flushWidget = () => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			try {
				const idleWarning = calculateIdleWarning(
					Date.now(),
					lastEventTime,
					IDLE_WARNING_THRESHOLD_MS,
				);
				ctx.ui.setWidget(
					widgetId,
					buildWidgetLines(state, agentName, agent.config.model, idleWarning),
				);
			} catch (renderErr: unknown) {
				const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
				getErrorCollector().push(
					"session-runner",
					"warn",
					`widget render error for ${agentName}: ${msg}`,
				);
			}
		};

		const scheduleFlush = () => {
			if (!flushTimer) {
				flushTimer = setTimeout(flushWidget, 300);
			}
		};

		// 2s heartbeat ensures terminal updates during quiet periods (LLM thinking).
		// Regular requestRender (not force=true) — TUI debounces internally to 16ms.
		// Try-catch prevents uncaught exceptions from killing the interval.
		heartbeatTimer = setInterval(() => {
			try {
				if (!flushTimer) flushWidget();
			} catch (hbErr: unknown) {
				const msg = hbErr instanceof Error ? hbErr.message : String(hbErr);
				getErrorCollector().push(
					"session-runner",
					"warn",
					`heartbeat error for ${agentName}: ${msg}`,
				);
			}
		}, 2000);

		let watchdogStarted = false;

		unsubscribe = session.subscribe((event: any) => {
			try {
				const eType = event?.type || "unknown";

				// ── Lazy watchdog start ──
				// Start watchdog on first streaming or tool event — not on lifecycle
				// events (session/agent_start/turn_start) that arrive before LLM API call.
				// This prevents false stall detection when model takes >30s for first token.
				// message_update always carries LLM deltas; tool_execution_start means LLM
				// has responded with a tool call.
				if (!watchdogStarted) {
					if (eType === "message_update" || eType === "tool_execution_start") {
						watchdogHandle?.start();
						watchdogStarted = true;
						log.debug("agent-session-runner", `Watchdog started for ${agentName} on ${eType}`);
					}
				}

				// Update last event time for idle detection and watchdog
				lastEventTime = Date.now();
				watchdogHandle?.reset();

				// Pause watchdog during long-running tool execution (e.g. web_crawl).
				// Tool execution produces zero SDK events while running — without pause,
				// a 30s crawl would trigger the watchdog timeout erroneously.
				// Only pause for tool_execution_start/end (process-managed tools).
				// SDK-provider-managed tools (e.g. web_search) emit their own events
				// and don't need special handling.
				if (eType === "tool_execution_start") {
					watchdogHandle?.pause();
				} else if (eType === "tool_execution_end") {
					watchdogHandle?.resume();
				}

				// Instrument: count events by kind
				const eventKind = eType;
				instrumenter?.incrementEvent(eventKind);

				const result = processSessionEvent(event, state);

				// Track phase transitions via instrumentation
				if (result.workingChange) {
					instrumenter?.trackPhase(state.phase);
				}

				if (result.workingChange) {
					scheduleFlush();

					const wm = getWorkingMessage(state, agentName);
					ctx.ui.setWorkingMessage(wm ?? undefined);
				}
			} catch (evErr: unknown) {
				const msg = evErr instanceof Error ? evErr.message : String(evErr);
				log.error("agent-session-runner", `Session event error for ${agentName}`, {
					eventType: event?.type,
					error: msg,
				});
				// Show notification to user with diagnostic context
				try {
					const notificationCtx = buildErrorNotificationContext(event, evErr);
					ctx.ui.notify(notificationCtx, "error");
				} catch {
					// notify fallback — don't let notification failure cascade
				}
			}
		});

		// ── Bug 2 fix: Properly settle session.prompt() on timeout ──
		// When timeout fires, session.abort() is called but session.prompt()
		// stays pending forever — leaked promise. Fix: wrap prompt so we can
		// await its settlement after the race completes.
		let timedOut = false;
		let promptSettled = false;
		let timeoutRef: NodeJS.Timeout | undefined;

		const timeoutPromise = new Promise<void>((_, reject) => {
			timeoutRef = setTimeout(async () => {
				timedOut = true;
				log.warn("agent-session-runner", `Agent ${agentName} timed out after ${timeoutMs}ms`);
				try {
					await session!.abort();
				} catch {
					// abort already handled — prompt will reject
				}
				reject(new Error(`Agent ${agentName} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});

		// Wrap prompt to track settlement
		const promptPromise = session
			.prompt(task)
			.then(() => {
				promptSettled = true;
			})
			.catch(() => {
				promptSettled = true;
			});

		try {
			await Promise.race([promptPromise, timeoutPromise]);
		} catch (promptErr: unknown) {
			// Check if this was a timeout
			if (timedOut) {
				const durationMs = Date.now() - startedAt;
				pushLog(state, `[Timeout: ${agentName} killed after ${formatDuration(durationMs)}]`);

				if (state.liveText.trim()) {
					state.textOutputLines.push(state.liveText.trim());
				}
				if (state.liveThinking.trim()) {
					state.thinkingOutputLines.push(state.liveThinking.trim());
				}

				// Wait for prompt to settle (abort should resolve/reject it)
				// This prevents the leaked promise chain from Bug 2
				if (!promptSettled) {
					try {
						await promptPromise;
					} catch {
						// Prompt settled via abort — expected
					}
				}

				// Capture messages BEFORE dispose — dispose may clear session state
				const messages = session?.state?.messages || [];

				// Cleanup
				try {
					session?.dispose();
				} catch {}
				try {
					unsubscribe?.();
				} catch {}
				if (flushTimer) clearTimeout(flushTimer);
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				watchdogHandle?.stop();
				ctx.ui.setWidget(widgetId, undefined);
				ctx.ui.setWorkingMessage(undefined);
				ctx.ui.setStatus("supervisor", undefined);
				return buildAgentRunResult(state, agentName, false, durationMs, messages);
			}
			// Re-throw other errors to be caught by outer catch
			throw promptErr;
		} finally {
			if (timeoutRef) clearTimeout(timeoutRef);
			// Ensure prompt is settled even on non-timeout errors
			if (!promptSettled) {
				try {
					await promptPromise;
				} catch {}
			}
		}

		// Watchdog fired check: session was aborted due to stalled event delivery
		// Throw so the outer catch block handles cleanup and returns error result,
		// which propagates to runAgent() → it checks result.success → subprocess fallback.
		if (watchdogFired) {
			const durationMs = Date.now() - startedAt;
			log.warn(
				"agent-session-runner",
				`Watchdog fired for ${agentName} — no events >${WATCHDOG_TIMEOUT_MS / 1000}s`,
			);
			pushLog(
				state,
				`[Stall: ${agentName} aborted after ${formatDuration(durationMs)} — no events for >${WATCHDOG_TIMEOUT_MS / 1000}s]`,
			);

			if (state.liveText.trim()) {
				state.textOutputLines.push(state.liveText.trim());
			}
			if (state.liveThinking.trim()) {
				state.thinkingOutputLines.push(state.liveThinking.trim());
			}

			// Ensure prompt settled to prevent leaked promise
			if (!promptSettled) {
				try {
					await promptPromise;
				} catch {
					// prompt settled via abort — expected
				}
			}

			// Throw to trigger subprocess fallback in runAgent()
			// Catch block handles session disposal, timer cleanup, widget clearing.
			log.info(
				"agent-session-runner",
				`Throwing stall error to trigger subprocess fallback for ${agentName}`,
			);
			throw new Error(`Agent ${agentName} stalled: no events for >${WATCHDOG_TIMEOUT_MS / 1000}s`);
		}

		// Budget exceeded check: abort session if budget (token/tool limit) was exceeded
		if (state.budgetExceeded) {
			try {
				await session!.abort();
			} catch {
				// session already aborted or disposed
			}
		}

		// Stop watchdog before final flush
		watchdogHandle?.stop();

		// Log instrumentation snapshot
		if (instrumenter) {
			const snap = instrumenter.snapshot();
			const timingParts = Object.entries(snap.phaseTiming)
				.filter(([_, ms]) => ms > 0)
				.map(([phase, ms]) => `${phase}:${ms}ms`);
			pushLog(
				state,
				`📊 Instrumentation: ${snap.eventsTotal} events, ${snap.toolCalls} tools, ${snap.thinkingDeltas} thinking deltas, ${snap.textDeltas} text deltas, ${snap.phaseTransitions} phase transitions, timing: ${timingParts.join(", ")}`,
			);
		}

		// Success path
		if (state.liveText.trim()) {
			state.textOutputLines.push(state.liveText.trim());
		}
		if (state.liveThinking.trim()) {
			state.thinkingOutputLines.push(state.liveThinking.trim());
		}

		// Flush final widget update then clear it
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		flushWidget();

		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}

		// Widget cleanup handled by ctx.ui.setWidget(widgetId, undefined) below.
		// No sendAgentProgressMessage/clearAgentProgressMessage needed.

		// Capture messages BEFORE dispose — dispose may clear session state
		const messages = session?.state?.messages || [];

		// Unsubscribe and dispose
		try {
			unsubscribe?.();
		} catch {}
		try {
			session?.dispose();
		} catch {}

		ctx.ui.setWidget(widgetId, undefined);
		ctx.ui.setWorkingMessage(undefined);
		ctx.ui.setStatus("supervisor", undefined);

		const durationMs = Date.now() - startedAt;

		log.info("agent-session-runner", `${agentName} completed successfully`, {
			durationMs,
			toolCount: state.toolCount,
			tokenCount: state.tokenCount,
			logLength: state.fullLog.length,
		});

		return buildAgentRunResult(state, agentName, true, durationMs, messages);
	} catch (err: unknown) {
		// Error path — always cleanup
		try {
			session?.dispose();
		} catch {}
		try {
			unsubscribe?.();
		} catch {}
		if (flushTimer) clearTimeout(flushTimer);
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		watchdogHandle?.stop();

		ctx.ui.setWidget(widgetId, undefined);
		ctx.ui.setWorkingMessage(undefined);
		ctx.ui.setStatus("supervisor", undefined);

		const durationMs = Date.now() - startedAt;
		const errorMsg = err instanceof Error ? err.message : String(err);

		log.warn("agent-session-runner", `${agentName} failed: ${errorMsg}`, {
			durationMs,
			toolCount: state.toolCount,
		});

		return {
			output: `In-process agent failed: ${errorMsg}`,
			success: false,
			agentName,
			toolCount: state.toolCount,
			tokenCount: state.tokenCount,
			durationMs,
			textOutput: state.fullLog.join("\n").trim(),
			textOnly: state.textOutputLines.join("\n").trim(),
			summaryLine: `Failed: ${errorMsg.slice(0, 120)}`,
			errorOutput: errorMsg,
			thinkingOutput:
				state.thinkingOutputLines.length > 0 ? state.thinkingOutputLines.join("\n\n") : undefined,
		};
	} finally {
		// Restore sandbox env var
		if (cwd) {
			if (_prevSandboxEnv) {
				process.env.WORKTREE_SANDBOX_PATH = _prevSandboxEnv;
			} else {
				delete process.env.WORKTREE_SANDBOX_PATH;
			}
		}
	}
}
