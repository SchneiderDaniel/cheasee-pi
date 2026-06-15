// ─── Subagent Tool ──────────────────────────────────────────────────
// pi.registerTool({name:"subagent"}) + exported executeSubagent() library function.
//
// The pipeline calls executeSubagent() programmatically (not via LLM tool dispatch)
// for per-agent execution with native inline rendering via onUpdate/renderCall/renderResult.
// The pi.registerTool() registration wraps executeSubagent() for optional LLM-callable usage.
//
// This is a clean implementation that duplicates session-creation logic from
// runAgentInProcess() because the latter is deeply coupled to widget/status/notification
// side effects that must be replaced with onUpdate calls.
//
// Architecture decision: No shared createSession() base — the two callers have
// fundamentally different lifecycle needs. See architecture in AGENTS.md.

import { existsSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	SessionManager,
	SettingsManager,
	DefaultResourceLoader,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { parseAgentFile } from "../agent/loader.ts";
import { resolveModel, buildToolList } from "../session/model.ts";
import { resolveExtensionPaths } from "../lib/extensions.ts";
import { extractSummaryLine } from "../lib/formatting.ts";
import { processSessionEvent, formatToolCall } from "../event/session-events.ts";
import { buildWidgetLines } from "../session/widget.ts";
import { createAgentRunState } from "../agent/runner.ts";
import { renderSubagentCall, renderSubagentResult } from "./renderer.ts";
import type {
	AgentToolResult,
	SubagentDetails,
	SubagentToolCall,
	ExecuteSubagentParams,
} from "./types.ts";

// ─── Constants ──────────────────────────────────────────────────────

/** Debounce interval for onUpdate during text streaming (ms) */
const ON_UPDATE_DEBOUNCE_MS = 300;

/** Maximum characters for content text in AgentToolResult (1MB).
 *  Large enough for thinking:high model outputs (architect) while
 *  retaining the JSON at the end for parseAgentOutput extraction.
 *  The TUI renderer has its own display cap (8KB expanded view). */
const MAX_CONTENT_CHARS = 1_000_000;

/** Widget key for the supervisor subagent progress widget */
const WIDGET_KEY = "supervisor-agent";

/** Debounce interval for widget updates (ms) */
const WIDGET_DEBOUNCE_MS = 300;

/** Heartbeat interval for widget during quiet periods (ms) */
const HEARTBEAT_MS = 2000;

// ─── executeSubagent — Library Function ─────────────────────────────
// Called programmatically by the pipeline handler. NOT via LLM tool dispatch.
// Creates an in-process AgentSession, subscribes with onUpdate streaming,
// and returns AgentToolResult<SubagentDetails>.

export async function executeSubagent(
	params: ExecuteSubagentParams,
	onUpdate?: (partial: AgentToolResult<Partial<SubagentDetails>>) => void,
	signal?: AbortSignal,
): Promise<AgentToolResult<SubagentDetails>> {
	const cwd = params.cwd || process.cwd();
	const agentName = params.agent;
	const task = params.task;
	const maxToolCalls = params.maxToolCalls ?? 0;
	const agentTokenBudget = params.agentTokenBudget ?? 0;

	// Optional UI adapter for widget-based progress (string-array overload only)
	const ui = params.ui;

	// ── 1. Load Agent File ─────────────────────────────────────────
	const agentPath = path.join(cwd, `.pi/extensions/supervisor/agents/${agentName}.md`);
	if (!existsSync(agentPath)) {
		throw new Error(`Subagent agent file not found: ${agentPath}`);
	}
	const agent = parseAgentFile(agentPath);

	// ── 2. Resolve Model ────────────────────────────────────────────
	const modelInfo = await resolveModel(agent.config.model || "");
	let resolvedModel: ReturnType<typeof getModel> | undefined;
	if (modelInfo) {
		try {
			resolvedModel = getModel(
				modelInfo.provider as Parameters<typeof getModel>[0],
				modelInfo.modelId as Parameters<typeof getModel>[1],
			);
		} catch (getModelErr: unknown) {
			const msg = getModelErr instanceof Error ? getModelErr.message : String(getModelErr);
			throw new Error(
				`Subagent ${agentName}: model "${modelInfo.provider}/${modelInfo.modelId}" not available — ${msg}`,
			);
		}
	}
	if (!resolvedModel) {
		const modelStr = agent.config.model || "(not configured)";
		throw new Error(
			`Subagent ${agentName}: model "${modelStr}" cannot be resolved — check provider/model configuration`,
		);
	}

	// ── 3. Build Tool List ──────────────────────────────────────────
	const toolNames = buildToolList(agent, cwd);

	// ── 4. Resolve Extension Paths ─────────────────────────────────
	const extPaths = resolveExtensionPaths(agent.config.extensions, cwd);

	// ── 5. Capture Agent Config for Result ─────────────────────────
	const agentModel = agent.config.model || "";

	// ── 6. Create Session & State ─────────────────────────────────
	const startedAt = Date.now();
	const state = createAgentRunState(startedAt, maxToolCalls, agentTokenBudget);
	const toolCalls: SubagentToolCall[] = [];

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let unsubscribe: (() => void) | undefined;

	// Track last onUpdate time for debouncing text deltas
	let lastUpdateTime = 0;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// ── Widget lifecycle ──
	// Uses string-array widget (buildWidgetLines) matching session-runner.ts pattern.
	// 300ms debounce + 2s heartbeat ensures terminal updates during quiet periods.
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	// Hoist variables accessible in all paths
	let capturedMessages: any[] = [];
	let timedOut = false;
	let timeoutRef: ReturnType<typeof setTimeout> | undefined;

	// Abort signal handler — hoisted so try/catch/finally all access same reference
	let abortHandler: (() => void) | undefined;

	try {
		// Set sandbox env var for worktree confinement extension
		const _prevSandboxEnv = process.env.WORKTREE_SANDBOX_PATH;
		if (cwd) {
			process.env.WORKTREE_SANDBOX_PATH = cwd;
		} else {
			delete process.env.WORKTREE_SANDBOX_PATH;
		}

		// ── 5a. Create Resource Loader ────────────────────────────
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			settingsManager: SettingsManager.inMemory(),
			systemPromptOverride: () => agent.systemPrompt,
			additionalExtensionPaths: extPaths.length > 0 ? extPaths : undefined,
			noExtensions: true,
		});
		await resourceLoader.reload();

		const sessionManager = SessionManager.inMemory(cwd);
		const settingsManager = SettingsManager.inMemory();

		// ── 5b. Create Agent Session ─────────────────────────────
		const sessionResult = await createAgentSession({
			cwd,
			sessionManager,
			resourceLoader,
			settingsManager,
			tools: toolNames.length > 0 ? toolNames : undefined,
			noTools: toolNames.length > 0 ? "builtin" : undefined,
			model: resolvedModel,
			thinkingLevel:
				(agent.config.thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh") ||
				undefined,
		});
		session = sessionResult.session;

		// ── Widget flush helpers (mirrors session-runner.ts) ──
		// flushWidget sends current state to widget. scheduleFlush debounces updates
		// at 300ms so rapid tool/thinking events don't re-render on every tick.
		const flushWidget = () => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			if (!ui) return;
			try {
				ui.setWidget(WIDGET_KEY, buildWidgetLines(state, agentName, agentModel));
			} catch (renderErr: unknown) {
				const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
				console.error(`[subagent/${agentName}] Widget error: ${msg}`);
			}
		};

		const scheduleFlush = () => {
			if (!ui) return;
			if (!flushTimer) {
				flushTimer = setTimeout(flushWidget, WIDGET_DEBOUNCE_MS);
			}
		};

		// Create initial widget with IDLE phase before agent starts
		if (ui) {
			try {
				ui.setWidget(WIDGET_KEY, buildWidgetLines(state, agentName, agentModel));
			} catch {
				// Non-critical
			}
		}

		// 2s heartbeat ensures terminal updates during quiet periods (LLM thinking)
		heartbeatTimer = setInterval(() => {
			try {
				if (!flushTimer) flushWidget();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[subagent/${agentName}] Heartbeat error: ${msg}`);
			}
		}, HEARTBEAT_MS);

		// Helper: send onUpdate with current state
		const sendUpdate = (phase?: string, isImmediate = false) => {
			// Always schedule widget update regardless of onUpdate presence.
			// This ensures the widget shows live progress even when
			// executeSubagent() is called without an onUpdate callback.
			scheduleFlush();

			if (!onUpdate) return;

			const now = Date.now();
			const durationMs = now - startedAt;

			// Determine whether to send this update
			if (!isImmediate && now - lastUpdateTime < ON_UPDATE_DEBOUNCE_MS) {
				// Debounce: schedule a trailing update if not already scheduled
				if (!debounceTimer) {
					debounceTimer = setTimeout(() => {
						debounceTimer = null;
						sendUpdate(undefined, true);
					}, ON_UPDATE_DEBOUNCE_MS);
				}
				return;
			}

			lastUpdateTime = now;

			// Build content text
			let statusText = `⏳ ${agentName} — ${state.phase} phase`;
			if (phase) {
				statusText = `⏳ ${agentName} — ${phase}`;
			}
			if (state.currentTool) {
				let parsedArgs: Record<string, unknown> | undefined;
				if (state.currentToolArgs) {
					try {
						parsedArgs = JSON.parse(state.currentToolArgs);
					} catch {
						// If args string is somehow invalid, proceed without parsed args
						parsedArgs = undefined;
					}
				}
				const formatted = formatToolCall(state.currentTool, parsedArgs);
				statusText = `⏳ ${agentName} — ${formatted}`;
			}

			// Include partial text output if available
			const liveOutput = state.liveText.trim() ? state.liveText.slice(0, 500) : "";

			onUpdate({
				content: [{ type: "text", text: statusText + (liveOutput ? "\n\n" + liveOutput : "") }],
				details: {
					agentName,
					success: false,
					statusLabel: "IN_PROGRESS",
					summaryLine: `Running ${agentName} — ${state.phase} phase`,
					model: agentModel,
					inputTokens: 0,
					outputTokens: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turnCount: 0,
					durationMs,
					toolCalls: [...toolCalls],
					taskPrompt: task,
				},
			});
		};

		// ── 5c. Subscribe to Session Events ──────────────────────
		unsubscribe = session.subscribe((event: any) => {
			try {
				const eventType = event?.type || "unknown";

				// Track tool calls for details
				if (eventType === "tool_execution_start") {
					toolCalls.push({
						name: (event.toolName as string) || "tool",
						args: (event.args as Record<string, unknown>) || {},
					});
				}

				const result = processSessionEvent(event, state);

				if (result.workingChange) {
					// Phase transition or working change → immediate onUpdate
					// Tool execution → immediate onUpdate
					if (state.phase === "tool" || eventType === "tool_execution_start") {
						sendUpdate(undefined, true);
					} else {
						sendUpdate();
					}
				}
			} catch (evErr: unknown) {
				// Log but don't crash the subscription loop
				const msg = evErr instanceof Error ? evErr.message : String(evErr);
				console.error(`[subagent/${agentName}] Event error: ${msg}`);
			}
		});

		// ── 6. Run Prompt with Timeout ───────────────────────────
		// Use a timeout promise to abort the session if it takes too long
		// Default timeout: 30 minutes (1800000ms) — generous for reasoning models
		const DEFAULT_TIMEOUT_MS = 1_800_000;

		const timeoutPromise = new Promise<void>((_, reject) => {
			timeoutRef = setTimeout(() => {
				timedOut = true;
				try {
					session!.abort().catch(() => {});
				} catch {
					// session already handled
				}
				reject(new Error(`Subagent ${agentName} timed out after ${DEFAULT_TIMEOUT_MS}ms`));
			}, DEFAULT_TIMEOUT_MS);
		});

		// Wire AbortSignal to session.abort() for clean cancellation
		// session.prompt() does not accept signal in PromptOptions, so we
		// call session.abort() when the signal fires.
		abortHandler = signal
			? () => {
					try {
						session!.abort().catch(() => {});
					} catch {
						// session already handled
					}
				}
			: undefined;
		if (abortHandler && signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}

		// Track prompt settlement to prevent leaked promise
		let promptSettled = false;
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
			// Handle timeout specifically
			if (timedOut) {
				// Wait for prompt to settle (abort should resolve/reject it)
				if (!promptSettled) {
					try {
						await promptPromise;
					} catch {
						// Expected — prompt settled via abort
					}
				}
				// Cleanup abort signal listener
				if (abortHandler && signal) {
					signal.removeEventListener("abort", abortHandler);
				}

				// Capture messages before dispose
				capturedMessages = session?.state?.messages || [];

				// Cleanup (includes widget cleanup)
				cleanupSession(
					session,
					unsubscribe,
					debounceTimer,
					cwd,
					_prevSandboxEnv,
					flushTimer,
					heartbeatTimer,
					ui,
					WIDGET_KEY,
				);

				const durationMs = Date.now() - startedAt;
				return buildSubagentResult(
					state,
					toolCalls,
					agentName,
					task,
					false,
					durationMs,
					capturedMessages,
					agentModel,
					`Timed out after ${durationMs}ms`,
				);
			}
			// Re-throw other errors
			throw promptErr;
		} finally {
			if (timeoutRef) clearTimeout(timeoutRef);
			// Ensure prompt is settled
			if (!promptSettled) {
				try {
					await promptPromise;
				} catch {
					// Expected
				}
			}
		}

		// ── 7. Build Success Result ─────────────────────────────

		// Finalize text output from state
		if (state.liveText.trim()) {
			state.textOutputLines.push(state.liveText.trim());
		}
		if (state.liveThinking.trim()) {
			state.thinkingOutputLines.push(state.liveThinking.trim());
		}

		// Send final onUpdate
		if (onUpdate) {
			const finalStatus = state.budgetExceeded
				? `✓ ${agentName} — budget exceeded (${state.toolCount} tools, ${state.tokenCount} tokens)`
				: `✓ ${agentName} — complete`;
			onUpdate({
				content: [{ type: "text", text: finalStatus }],
				details: {
					agentName,
					success: true,
					statusLabel: state.budgetExceeded ? "BUDGET_EXCEEDED" : "SUCCESS",
					summaryLine: extractSummaryLine(state.textOutputLines.join("\n"), true, agentName),
					model: agentModel,
					inputTokens: 0,
					outputTokens: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turnCount: 0,
					durationMs: Date.now() - startedAt,
					toolCalls: [...toolCalls],
					taskPrompt: task,
				},
			});
		}

		// Cleanup abort signal listener
		if (abortHandler && signal) {
			signal.removeEventListener("abort", abortHandler);
		}

		// Capture messages before dispose
		capturedMessages = session?.state?.messages || [];

		// Final widget flush shows complete state before cleanup
		flushWidget();

		// Cleanup (includes widget cleanup)
		cleanupSession(
			session,
			unsubscribe,
			debounceTimer,
			cwd,
			_prevSandboxEnv,
			flushTimer,
			heartbeatTimer,
			ui,
			WIDGET_KEY,
		);

		const durationMs = Date.now() - startedAt;
		return buildSubagentResult(
			state,
			toolCalls,
			agentName,
			task,
			true,
			durationMs,
			capturedMessages,
			agentModel,
			undefined,
		);
	} catch (err: unknown) {
		// Error path — always cleanup
		// Remove abort signal listener
		if (abortHandler && signal) {
			signal.removeEventListener("abort", abortHandler);
		}
		// Cleanup (cleanupSession clears widget)
		cleanupSession(
			session,
			unsubscribe,
			debounceTimer,
			cwd,
			undefined,
			flushTimer,
			heartbeatTimer,
			ui,
			WIDGET_KEY,
		);

		const durationMs = Date.now() - startedAt;
		const errorMsg = err instanceof Error ? err.message : String(err);

		// Send error onUpdate
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: `✗ ${agentName} — failed: ${errorMsg}` }],
				details: {
					agentName,
					success: false,
					statusLabel: "FAILED",
					summaryLine: `Failed: ${errorMsg.slice(0, 120)}`,
					model: agentModel,
					inputTokens: 0,
					outputTokens: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turnCount: 0,
					durationMs,
					toolCalls: [...toolCalls],
					taskPrompt: task,
				},
			});
		}

		return {
			content: [
				{
					type: "text",
					text: `Subagent ${agentName} failed: ${errorMsg}`,
				},
			],
			details: {
				agentName,
				success: false,
				statusLabel: "FAILED",
				summaryLine: `Failed: ${errorMsg.slice(0, 120)}`,
				model: agentModel,
				inputTokens: 0,
				outputTokens: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turnCount: 0,
				durationMs,
				toolCalls: [...toolCalls],
				taskPrompt: task,
			},
		};
	}
}

// ─── registerSubagentTool — pi.registerTool Registration ────────────
// Wraps executeSubagent for LLM-callable subagent capability.
// The LLM can invoke "subagent" as a tool during non-pipeline work.

export function registerSubagentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Execute a specialized sub-agent (architect, developer, auditor, researcher, test-designer) " +
			"with its own model, tools, and system prompt. Returns structured output with usage stats. " +
			"Use this to delegate complex work to a specialized agent that can run independently. " +
			"Progress is streamed inline via onUpdate for native tool rendering.",
		promptSnippet: "Delegate task to a specialized sub-agent with its own model and tools",
		promptGuidelines: [
			"- Use subagent to delegate complex work that benefits from a specialized agent (architecture, implementation, audit, research, test design).",
			"- The subagent runs with its own model, tools, and system prompt from the supervisor extension configuration.",
			"- Progress is streamed inline — you'll see the subagent's tool calls and output as they happen.",
		],
		parameters: Type.Object({
			agent: Type.String({
				description:
					"Agent name: one of 'architect', 'developer', 'auditor', 'researcher', 'test-designer'",
			}),
			task: Type.String({
				description: "Full task description for the sub-agent to execute",
			}),
		}),
		renderCall: renderSubagentCall as any,
		renderResult: renderSubagentResult as any,
		execute: (async (_toolCallId: any, params: any, signal: any, onUpdate: any, _ctx: any) => {
			const agent = String(params?.agent || "");
			const task = String(params?.task || "");
			const cwd = String(_ctx?.cwd || process.cwd());

			if (!agent) {
				throw new Error("subagent: 'agent' parameter is required");
			}
			if (!task) {
				throw new Error("subagent: 'task' parameter is required");
			}

			// onUpdate may be undefined or a function — pass through with type assertion
			// since the pi SDK's AgentToolUpdateCallback type doesn't align with our local type
			const onUpdateFn =
				typeof onUpdate === "function"
					? (onUpdate as (partial: AgentToolResult<Partial<SubagentDetails>>) => void)
					: undefined;

			return executeSubagent({ agent, task, cwd }, onUpdateFn, signal as AbortSignal | undefined);
		}) as any,
	});
}

// ─── Internal Helpers ───────────────────────────────────────────────

/**
 * Clean up session resources: dispose session, unsubscribe, clear timer,
 * restore WORKTREE_SANDBOX_PATH.
 */
function cleanupSession(
	session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined,
	unsubscribe: (() => void) | undefined,
	debounceTimer: ReturnType<typeof setTimeout> | null,
	cwd: string | undefined,
	prevSandboxEnv: string | undefined,
	flushTimer?: ReturnType<typeof setTimeout> | null,
	heartbeatTimer?: ReturnType<typeof setInterval> | null,
	ui?: { setWidget(id: string, lines?: string[]): void },
	widgetKey?: string,
): void {
	try {
		unsubscribe?.();
	} catch {
		// Non-critical
	}
	try {
		session?.dispose();
	} catch {
		// Non-critical
	}
	if (debounceTimer) {
		clearTimeout(debounceTimer);
		debounceTimer = null;
	}
	// Clear widget-related timers
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
	// Clear widget from editor area
	if (ui && widgetKey) {
		try {
			ui.setWidget(widgetKey, undefined);
		} catch {
			// Non-critical
		}
	}
	// Restore sandbox env var
	if (cwd) {
		if (prevSandboxEnv) {
			process.env.WORKTREE_SANDBOX_PATH = prevSandboxEnv;
		} else {
			delete process.env.WORKTREE_SANDBOX_PATH;
		}
	}
}

/**
 * Build AgentToolResult<SubagentDetails> from session state and messages.
 */
function buildSubagentResult(
	state: ReturnType<typeof createAgentRunState>,
	toolCalls: SubagentToolCall[],
	agentName: string,
	taskPrompt: string,
	success: boolean,
	durationMs: number,
	messages: any[],
	model: string,
	errorMsg?: string,
): AgentToolResult<SubagentDetails> {
	// Use fullLog (all streamed lines) instead of textOutputLines (only leftover at text_end).
	// Streaming models emit text via text_delta events; complete newline-terminated lines are
	// pushed to fullLog via pushLog() but not to textOutputLines. textOutputLines only captures
	// whatever is left in liveText at text_end, which is often empty or just "```".
	// Using fullLog ensures the agent's JSON output (typically at the end) is included,
	// so extractAgentCommentBody and parseAgentOutput can find and parse it.
	const fullText = state.fullLog.join("\n").trim();
	const textOutput = fullText;
	const textOnly = state.textOutputLines.join("\n").trim();
	const summaryLine = errorMsg
		? `Failed: ${errorMsg.slice(0, 120)}`
		: extractSummaryLine(fullText, success, agentName);

	// Extract usage stats from messages
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let turnCount = 0;

	if (Array.isArray(messages) && messages.length > 0) {
		// Last assistant message for cumulative usage
		const lastAsstMsg = [...messages]
			.reverse()
			.find((m: any) => m && m.role === "assistant" && m.usage);
		if (lastAsstMsg?.usage) {
			const u = lastAsstMsg.usage;
			inputTokens = typeof u.input === "number" ? u.input : 0;
			outputTokens = typeof u.output === "number" ? u.output : 0;
			cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : 0;
			cacheWrite = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
			cost = u.cost?.total ?? 0;
		}

		// Turn count: count assistant messages with usage.input > 0
		turnCount = messages.filter(
			(m: any) =>
				m &&
				m.role === "assistant" &&
				m.usage &&
				typeof m.usage.input === "number" &&
				m.usage.input > 0,
		).length;
	}

	// Build content text (capped at MAX_CONTENT_CHARS)
	let contentText = textOutput || summaryLine;
	if (contentText.length > MAX_CONTENT_CHARS) {
		contentText =
			contentText.slice(0, MAX_CONTENT_CHARS) +
			`\n…[truncated: output exceeds ${MAX_CONTENT_CHARS} chars]`;
	}

	const statusLabel = success ? (state.budgetExceeded ? "BUDGET_EXCEEDED" : "SUCCESS") : "FAILED";

	return {
		content: [{ type: "text", text: contentText }],
		details: {
			agentName,
			success,
			statusLabel,
			summaryLine,
			model,
			inputTokens,
			outputTokens,
			cacheRead,
			cacheWrite,
			cost,
			turnCount,
			durationMs,
			toolCalls,
			taskPrompt,
		},
	};
}
