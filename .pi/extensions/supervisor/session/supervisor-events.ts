// ─── Supervisor Event Contract ────────────────────────────────────
// Discriminated union of all lifecycle events emitted by the supervisor
// during subagent execution. Single source of truth consumed by both
// the event producer (pipeline/handler.ts) and the event consumer
// (session/message-renderer.ts).
//
// Every event has an `eventType` discriminator. The message renderer
// dispatches via a single `switch(details.eventType)` — no parallel
// branches for `_progressUpdate` / `_subagentResult` / `toolCallResult`.

import type { SubagentDetails } from "../subagent/types.ts";

/**
 * Supervisor event details — discriminated union.
 * Narrow via `details.eventType` at compile time.
 */
export type SupervisorEventDetails =
	| {
			eventType: "phase-change";
			agentName: string;
			phase: string;
	  }
	| {
			eventType: "tool-start";
			agentName: string;
			toolName: string;
			args: string;
			params?: string;
	  }
	| {
			eventType: "tool-complete";
			agentName: string;
			toolName: string;
			args: string;
			params?: string;
			isError: boolean;
			errorReason?: string;
			resultText?: string;
			thinking?: string;
			toolIndex?: string;
			runningTokenCount?: number;
			runningToolCount?: number;
			toolDurationMs?: number;
			errorCount?: number;
			maxToolCalls?: number;
			agentTokenBudget?: number;
			compacted?: boolean;
	  }
	| {
			eventType: "thinking";
			agentName: string;
			content: string;
	  }
	| {
			eventType: "error";
			agentName: string;
			toolName?: string;
			errorReason: string;
	  }
	| {
			eventType: "budget-exceeded";
			agentName: string;
			toolCount: number;
			tokenCount: number;
	  }
	| {
			eventType: "compaction";
			agentName: string;
	  }
	| {
			eventType: "subagent-result";
			agentName: string;
			content: import("../subagent/types.ts").AgentToolResult<SubagentDetails>["content"];
			details: SubagentDetails;
	  };

/**
 * Compile-time exhaustiveness check helper.
 * Use as the default case in a switch on `eventType` to ensure
 * all variants are handled:
 *
 *   switch (ev.eventType) {
 *     case "phase-change": ...
 *     default: assertNever(ev);
 *   }
 */
export function assertNever(x: never): never {
	throw new Error(`Unhandled supervisor event type: ${JSON.stringify(x)}`);
}
