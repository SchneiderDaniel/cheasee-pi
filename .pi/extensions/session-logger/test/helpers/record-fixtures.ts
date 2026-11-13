/**
 * record-fixtures.ts — Shared JSONL record fixtures for session-logger tests.
 *
 * The JSONL mappers in `.pi/extensions/session-logger.ts` are internal (no
 * production symbol to import), so the suites replicate them. Those replicas
 * used to be copy-pasted into every `session-logger*.test.mts` `-partN` file;
 * the shared ones live here instead (issue #2105).
 *
 * Scope: the record shape (`LogRecord`, `TokenUsage`), `extractText` and the
 * user-message mapper. Per-suite mappers (`assistantMessageToRecord`,
 * `toolResultToRecord`, …) stay with the suites that assert on them.
 */

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export interface LogRecord {
	timestamp: string;
	agent: string;
	tool: string;
	token_usage?: TokenUsage;
	error: string | null;
	loop_step: number;
	payload: Record<string, unknown>;
}

/** Flatten message content to text: strings pass through, text blocks join with a blank line. */
export function extractText(blocks: unknown): string {
	if (typeof blocks === "string") return blocks;
	if (!Array.isArray(blocks)) return "";
	return blocks
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text)
		.join("\n\n");
}

/** Map an SDK user message to a JSONL record (no token usage, `error` always null). */
export function userMessageToRecord(msg: any, step: number): LogRecord {
	const text = extractText(msg.content);
	return {
		timestamp:
			typeof msg.timestamp === "string" ? msg.timestamp : new Date(msg.timestamp).toISOString(),
		agent: "user",
		tool: "message",
		error: null,
		loop_step: step,
		payload: { role: "user", content: text },
	};
}
