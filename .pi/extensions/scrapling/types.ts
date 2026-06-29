/**
 * Shared types for scrapling extension
 */

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
	signal?: string;
}

/**
 * Check if an ExecResult represents a subprocess failure.
 *
 * Catches both non-zero exit codes AND signal-killed subprocesses
 * (where upstream `execCommand` may report code: 0 despite the process
 * being killed by a signal like SIGTERM from timeout/abort).
 *
 * This is the single source of truth for failure detection — all callers
 * should use this instead of checking `result.code !== 0` directly.
 *
 * Workaround for upstream bug: once @earendil-works/pi-agent-core
 * fixes `code ?? 0` → `code ?? -1`, this still works correctly.
 */
export function isExecFailure(result: ExecResult): boolean {
	return result.code !== 0 || result.killed;
}

export interface ExecFn {
	(
		cmd: string,
		args: string[],
		opts?: { timeout?: number; signal?: AbortSignal; maxBuffer?: number },
	): Promise<ExecResult>;
}

export interface OnUpdateCallback {
	(u: { content: Array<{ type: "text"; text: string }>; details: unknown }): void;
}

export interface CrawlParams {
	url: string;
	maxPages: number;
	maxTokens?: number;
}

export interface CrawledPage {
	url: string;
	markdown: string;
	method: "lightweight" | "stealth";
	rawLength: number;
}

export type CrawlResult =
	| { success: true; results: CrawledPage[]; totalTokens: number }
	| { success: false; error: string };
