/**
 * Shared types for scrapling extension
 */

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
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
