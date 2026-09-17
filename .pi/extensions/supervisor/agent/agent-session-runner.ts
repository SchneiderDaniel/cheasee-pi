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
	deadlineMs?: number | null,
): Promise<AgentRunResult> {
	const log = getDebugLogger();
	const effectiveCwd = cwd || ctx.cwd || process.cwd();
	const agentName = agent.config.name;
	const startedAt = Date.now();

	// ── Absolute wall-clock bound, armed BEFORE all setup (audit #1) ──
	// The dispatch deadline is absolute (or derived from the configured
	// timeout at entry). Model resolution, tool resolution, UI setup, SDK
	// load and session creation all run inside it, so no setup work can push
	// the configured window out. The CONFIGURED timeout is carried separately
	// from the remaining watchdog budget, so failure state reports the
	// configured duration, never a decreasing slice (audit #3).
	const absoluteDeadlineMs = timeoutMs === null ? null : (deadlineMs ?? startedAt + timeoutMs);
	const remainingMs =
		absoluteDeadlineMs === null ? null : Math.max(0, absoluteDeadlineMs - Date.now());

	// ── Single cancellation lifecycle (audit #1/#2) ──
	// ONE ref'd timer (not AbortSignal.timeout — a ref'd handle keeps the event
	// loop alive while the run hangs) + ONE deferred represent the deadline.
	// The timer marks the run cancelled and aborts a live session; the setup +
	// prompt body re-checks `timedOut` after EVERY await so a step resolving
	// after the deadline can neither subscribe nor prompt, and anything it
	// materialises late is disposed (late-disposal handlers at the setup sites).
	let timedOut = false;
	let session: any = null;
	// Ref object: `bodyError` is assigned only inside the body's async catch,
	// so a bare `let` would narrow to `never` at the outer reads (same TS
	// control-flow collapse documented for unsubRef below).
	const bodyErrorRef: { current: Error | null } = { current: null };
	let flushTimer: NodeJS.Timeout | null = null;
	// Ref object keeps the unsubscribe fn's declared type across closures
	// (a bare `let x = null` assigned in a closure collapses to `never`).
	const unsubRef: { current: (() => void) | null } = { current: null };
	const disposedSessions = new WeakSet<object>();

	function disposeSessionValue(s: any): void {
		if (!s || disposedSessions.has(s)) return;
		disposedSessions.add(s);
		if (typeof s.dispose === "function") {
			try {
				s.dispose();
			} catch (disposeErr: unknown) {
				const msg = disposeErr instanceof Error ? disposeErr.message : String(disposeErr);
				log.warn("agent-runner", `Session dispose error for ${agentName}: ${msg}`);
			}
		}
	}

	function disposeSession(): void {
		const s = session;
		session = null;
		disposeSessionValue(s);
	}

	function abortNow(): void {
		timedOut = true;
		if (session) {
			try {
				session.abort();
			} catch (abortErr: unknown) {
				const msg = abortErr instanceof Error ? abortErr.message : String(abortErr);
				log.warn("agent-runner", `Session abort error for ${agentName}: ${msg}`);
			}
		}
	}

	let resolveDeadline: () => void = () => {};
	const deadlineFired: Promise<void> | null =
		remainingMs === null
			? null
			: new Promise<void>((r) => {
					resolveDeadline = r;
				});
	const deadlineTimer: NodeJS.Timeout | null =
		remainingMs === null
			? null
			: setTimeout(() => {
					if (!timedOut) abortNow();
					resolveDeadline();
				}, remainingMs);

	/**
	 * Synchronous deadline guard (audit finding #1). The ref'd timer above only
	 * fires in the timers phase, so cached SDK + already-resolved session/prompt
	 * promises can drain entirely through microtasks BEFORE the timer callback
	 * runs — a run whose remaining budget is zero then reaches `prompt()` and can
	 * return success=true after its absolute deadline. Re-checking `Date.now()`
	 * at every synchronous decision point (before/after setup, before subscribe,
	 * immediately before prompt) makes the bound absolute regardless of event
	 * loop phase ordering. Expiry is marked terminal here so the result is a
	 * structured timeout.
	 */
	function expired(): boolean {
		if (timedOut) return true;
		if (absoluteDeadlineMs === null || Date.now() < absoluteDeadlineMs) return false;
		abortNow();
		resolveDeadline();
		return true;
	}

	/**
	 * Await one setup step, but stop waiting the moment the deadline fires: a
	 * never-settling ensureSDK()/createAgentSession() cannot hold the body open.
	 * The abandoned step keeps running, but this body returns so no
	 * subscribe/prompt follows, and any session it later materialises is
	 * terminated by the late-disposal handler attached at its creation site.
	 */
	async function awaitSetup<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
		if (!deadlineFired) return { ok: true, value: await p };
		return Promise.race<{ ok: true; value: T } | { ok: false }>([
			p.then((value) => ({ ok: true as const, value })),
			deadlineFired.then(() => ({ ok: false as const })),
		]);
	}

	try {
		// Resolve model before loading SDK (fail fast). Inside the armed bound:
		// a slow resolution cannot extend the configured window (audit #1).
		const modelStr = agent.config.model || "";
		const resolvedModel = resolveModel(modelStr);
		if (!resolvedModel) {
			throw new Error(
				`Model "${agent.config.model}" could not be resolved for agent "${agentName}"`,
			);
		}

		const tools = buildToolList(agent, effectiveCwd);
		const thinkingLevel = agent.config.thinking?.trim() || undefined;

		log.info("agent-runner", `runAgentInProcess: ${agentName}`, {
			effectiveCwd,
			model: modelStr,
			timeoutMs,
			remainingMs,
			tools: tools.join(","),
			taskLen: task.length,
		});

		ctx.ui.notify(`Running agent: ${agentName}...`, "info");
		ctx.ui.setStatus("supervisor", `Running ${agentName}...`);

		const state = createAgentRunState(startedAt, maxToolCalls, agentTokenBudget, thinkingLevel);

		const widgetId = `agent-${agentName}`;

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

	// Setup + prompt run as ONE cancellable body: the SDK load, session
	// creation AND the prompt share the single absolute bound armed above.
	// `timedOut` is re-checked after every await so a slow setup that resolves
	// after the deadline can never start provider work (audit finding #2);
	// there is no await between the final check and `session.prompt()`, so the
	// ref'd timer cannot interleave a window there.
	const runBody = async (): Promise<void> => {
		// The deadline may already be spent at entry (e.g. an absolute dispatch
		// deadline in the past): never start setup, never prompt (audit #1).
		if (expired()) return;
		// Load SDK dynamically — raced against the deadline so a never-settling
		// import cannot hold the body open (audit #2).
		if (!(await awaitSetup(ensureSDK())).ok) return;
		// Sync setup (model/tool resolution) ran before this body; re-check so a
		// budget exhausted during it cannot roll into session creation.
		if (expired()) return;

		// Build session manager (file-backed for session persistence)
		// Use effectiveCwd (not sessionPath) — SessionManager.create expects a cwd,
		// not a file path. The SDK writes the session file to a default location.
		// execute-agent.ts uses result.output for replay instead of replaySessionFile.
		const sessionManager = _SessionManager ? _SessionManager.create(effectiveCwd) : undefined;

		// Create in-process agent session
		const createAgentSession = _createAgentSession!;

		// Guard: verify model resolved before creating session
		if (!resolvedModel) {
			throw new Error(
				`Model "${agent.config.model}" could not be resolved for agent "${agent.config.name}"`,
			);
		}

		const sessionPromise: Promise<any> = createAgentSession({
			model: resolvedModel,
			tools,
			sessionManager,
			thinkingLevel: thinkingLevel || undefined,
			cwd: effectiveCwd,
		});
		// A session that materialises AFTER the deadline must still be
		// terminated: the body may already have returned on the deadline race,
		// so no later disposeSession() would ever see it (audit #2).
		sessionPromise
			.then((late: any) => {
				if (timedOut && session !== late) disposeSessionValue(late);
				return late;
			})
			.catch((lateErr: unknown) => {
				// Rejection is surfaced by the awaited setup below, or intentionally
				// dropped once the deadline won; log so it is never silent.
				const msg = lateErr instanceof Error ? lateErr.message : String(lateErr);
				log.warn("agent-runner", `Session setup failed for ${agentName}: ${msg}`);
			});

		const created = await awaitSetup(sessionPromise);
		if (!created.ok) return; // deadline fired during session creation
		session = created.value;

		// Session materialized after the deadline → dispose it here and never
		// prompt; provider work must not start post-timeout.
		if (expired()) {
			disposeSession();
			return;
		}

		// Set up subscription BEFORE calling session.prompt()
		const pending = createForwardChatState();
		// SUBSCRIBING MATERIALISES PROVIDER WORK: re-check the absolute deadline
		// immediately before the side-effecting subscribe (audit #1).
		if (expired()) {
			disposeSession();
			return;
		}
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

		// No await between this guard and prompt(): a timed-out run never starts
		// a prompt even if the subscription setup above had already begun.
		if (expired()) {
			if (unsubRef.current) {
				unsubRef.current();
				unsubRef.current = null;
			}
			disposeSession();
			return;
		}

		// Await the prompt — its rejection (provider error OR the abort()
		// from the deadline firing) settles the body race.
		await session.prompt(task);
	};

	// The body's rejection is captured (never raced raw), so an abandoned
	// setup cannot surface an unhandled rejection while the deadline wins.
	const body = runBody().catch((err: unknown) => {
		bodyErrorRef.current = err instanceof Error ? err : new Error(String(err));
	});
	if (deadlineFired) {
		await Promise.race([body, deadlineFired]);
	} else {
		await body;
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
	const bodyError = bodyErrorRef.current;
	const success = !bodyError && !timedOut && !state.budgetExceeded;

	if (timedOut) {
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
	if (bodyError && !timedOut) {
		throw bodyError;
	}

	// Timeout failures are authored into errorOutput (not just textOutput)
	// so buildAgentResultEntry / the pipeline summary table retain them.
	// `timeoutMs` is the CONFIGURED timeout (never the remaining budget), so
	// the note and structured state report the configured duration (audit #3).
	let errorOutput = bodyError ? bodyError.message : "";
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
	} finally {
		// Single teardown for every exit (success, timeout, or a synchronous
		// setup throw): unsubscribe, dispose the session, and clear every timer
		// so a configured-but-unfired deadline cannot keep the event loop alive.
		if (deadlineTimer) clearTimeout(deadlineTimer);
		if (unsubRef.current) {
			unsubRef.current();
			unsubRef.current = null;
		}
		disposeSession();
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
	}
}


