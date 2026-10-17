// ─── JSON event kind table — core kinds (VBA god module split #2036) ───
// Split from normalize.ts: session lifecycle, context, tool execution and
// message/turn/agent boundary extractors.

import type { KindEntry } from "./normalize-types.ts";

export const coreKindTable: Record<string, KindEntry> = {
	session: {
		json: () => ({ kind: "session" }),
	},

	context_info: {
		json: (ev) => ({
			kind: "context_info",
			contextTokens: ev.contextTokens as number,
			contextWindow: ev.contextWindow as number,
		}),
	},

	tool_execution_start: {
		json: (ev) => ({
			kind: "tool_execution_start",
			toolName: (ev.toolName as string) || "tool",
			args: ev.args,
			parentToolCallId: (ev.parentToolCallId as string) || undefined,
		}),
	},

	tool_execution_end: {
		json: (ev) => ({
			kind: "tool_execution_end",
			toolName: (ev.toolName as string) || "tool",
			isError: !!ev.isError,
			parentToolCallId: (ev.parentToolCallId as string) || undefined,
		}),
	},

	message_end: {
		json: (ev) => ({ kind: "message_end", message: ev.message as any }),
	},

	done: {
		json: (ev) => {
			if ((ev.type as string) === "message_update") return null;
			return { kind: "done", message: ev.message as any };
		},
	},

	turn_start: {
		json: () => ({ kind: "turn_start" }),
	},

	turn_end: {
		json: () => ({ kind: "turn_end" }),
	},

	agent_start: {
		json: () => ({ kind: "agent_start" }),
	},

	agent_end: {
		json: () => ({ kind: "agent_end" }),
	},
};
