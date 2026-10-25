// --- Tool event handlers ----------------------------------------
// `tool_execution_start` / `tool_execution_end` to AgentRunState. Split out of
// handlers.ts (issue #2033); presentation translation only, no pipeline
// decisions.

import type { AgentRunState } from "../../config/types.ts";
import type { NestedCall } from "../../subagent/types.ts";
import { MAX_NESTED_CALLS } from "../../session/message-renderers/constants.ts";
import { pushLog } from "../../agent/state-helpers.ts";
import { renderToolCallText } from "../../lib/render-helpers.ts";
import { extractTextFromContent } from "../../lib/formatting.ts";
import type { NormalizedEvent, HandlerResult } from "./normalize.ts";

const MAX_ARGS_STRING_LEN = 100;

function truncateArgsForDisplay(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return {};
	}
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		if (typeof value === "string") {
			result[key] =
				value.length > MAX_ARGS_STRING_LEN ? value.slice(0, MAX_ARGS_STRING_LEN) + "..." : value;
		} else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			result[key] = truncateArgsForDisplay(value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

export function handleToolExecutionStart(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "tool_execution_start" },
	cwd?: string,
): HandlerResult {
	// Nested calls (ctx.executeTool) never enter the top-level tool/phase/log
	// stream; they are recorded at end as a bounded nestedCalls list.
	if (ev.parentToolCallId) {
		return { flush: false, workingChange: false };
	}
	const prevPhase = state.phase;
	state.currentTool = ev.toolName || "tool";
	state.currentToolArgs = ev.args ? JSON.stringify(truncateArgsForDisplay(ev.args)) : undefined;
	state.lastToolName = ev.toolName;
	// Track tool name in session state for tool-call line filtering
	if (ev.toolName && !state.toolCalls.includes(ev.toolName)) {
		state.toolCalls.push(ev.toolName);
	}
	state.phase = "tool";
	pushLog(state, renderToolCallText(ev.toolName, ev.args, cwd ?? process.cwd()));
	return { flush: true, workingChange: prevPhase !== "tool" };
}

export function handleToolExecutionEnd(
	state: AgentRunState,
	ev: NormalizedEvent & { kind: "tool_execution_end" },
): HandlerResult {
	// Nested end: record into the bounded nestedCalls list and count errors.
	// `nestedErrorCount` is the authoritative error total — it is incremented
	// BEFORE the cap check, so it can exceed the errors visible in the stored
	// list (a dropped errored call still counts).
	// Top-level toolCount/failedToolCount are intentionally left untouched.
	if (ev.parentToolCallId) {
		if (ev.isError) state.nestedErrorCount = (state.nestedErrorCount ?? 0) + 1;
		const calls = state.nestedCalls ?? (state.nestedCalls = []);
		if (calls.length < MAX_NESTED_CALLS) {
			const call: NestedCall = {
				name: ev.toolName || "tool",
				status: ev.isError ? "error" : "ok",
			};
			calls.push(call);
		} else {
			state.nestedTruncated = true;
		}
		return { flush: true, workingChange: false };
	}
	state.toolCount++;
	if (ev.isError) {
		state.failedToolCount = (state.failedToolCount ?? 0) + 1;
	}
	state.currentTool = undefined;
	state.currentToolArgs = undefined;
	state.phase = "idle";
	pushLog(state, `${ev.isError ? "✗" : "✓"} ${ev.toolName}`);
	return { flush: true, workingChange: true };
}
