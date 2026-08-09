/**
 * Shared types for scrapling extension
 */

// Diverges from lib/port-types.ExecResult: adds killed/signal for killed-process detection
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

// Diverges from lib/port-types.ExecFn: opts adds maxBuffer, return uses divergent ExecResult
// Diverges from lib/port-types.ExecResult: adds killed/signal
export interface ExecFn {
	(
		cmd: string,
		args: string[],
		opts?: { timeout?: number; signal?: AbortSignal; maxBuffer?: number },
	): Promise<ExecResult>;
}

export type { OnUpdateCallback } from "../lib/port-types.ts";

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
