// ─── Event normalization types (VBA god module split #2036) ───
// Types moved out of normalize.ts so the kind-table modules can share them
// without a value-level import cycle.

export type NormalizedUsage = {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
};

export type NormalizedEvent =
	| { kind: "tool_execution_start"; toolName: string; args?: unknown; parentToolCallId?: string }
	| { kind: "tool_execution_end"; toolName: string; isError?: boolean; parentToolCallId?: string }
	| { kind: "thinking_start" }
	| { kind: "thinking_end" }
	| { kind: "thinking_delta"; delta: string }
	| { kind: "text_start" }
	| {
			kind: "text_end";
			usage?: NormalizedUsage;
	  }
	| { kind: "text_delta"; delta: string }
	| {
			kind: "message_end";
			message: {
				role: string;
				content?: Array<
					Record<string, unknown> & { type: string; text?: string; thinking?: string }
				>;
				toolName?: string;
				usage?: NormalizedUsage;
			};
	  }
	| {
			kind: "done";
			message: {
				content?: Array<
					Record<string, unknown> & { type: string; text?: string; thinking?: string }
				>;
				usage?: NormalizedUsage;
			};
	  }
	| { kind: "context_info"; contextTokens: number; contextWindow: number }
	| { kind: "turn_start" }
	| { kind: "turn_end" }
	| { kind: "agent_start" }
	| { kind: "agent_end" }
	| { kind: "session" };

export interface HandlerResult {
	flush: boolean;
	workingChange: boolean;
}

export type JsonEvent = Record<string, unknown>;

type Extractor = (ev: Record<string, unknown>) => NormalizedEvent | null;

export interface KindEntry {
	json: Extractor;
}
