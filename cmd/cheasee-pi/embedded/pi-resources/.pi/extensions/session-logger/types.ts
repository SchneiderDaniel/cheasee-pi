export interface SessionLoggerGate {
	enabledForNextSession: boolean;
	sessionEnabled: boolean;
}

export interface Metadata {
	sessionId: string;
	name?: string;
	mode?: string;
	messages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	compactions: number;
	modelChanges: Array<{ time: string; model: string }>;
	thinkingChanges: Array<{ time: string; level: string }>;
	/** Per-turn token breakdown */
	perTurnTokens?: Array<{
		turnIndex: number;
		tokens: number;
		cost: number;
		toolCount: number;
		errorCount: number;
	}>;
	/** Tool execution stats */
	toolStats?: Record<
		string,
		{
			calls: number;
			errors: number;
			totalDurationMs: number;
		}
	>;
	/** Per-agent breakdown of subagent tool calls from supervisor pipeline runs */
	subagentToolStats?: Record<
		string,
		Record<
			string,
			{
				calls: number;
				errors: number;
				totalDurationMs: number;
			}
		>
	>;
	/** File modifications tracked during session */
	fileModifications?: Array<{
		action: string;
		path: string;
		timestamp: string;
		size?: number;
	}>;
}
