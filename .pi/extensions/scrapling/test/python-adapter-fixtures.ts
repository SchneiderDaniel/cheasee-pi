// ─── scrapling python-adapter test fixtures (issue #2005 Long File split) ───
// Shared helpers moved out of python-adapter.test.ts. Non-test module so
// `node --test` does not load it as a suite.

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExecFn, CrawlResult } from "../types.ts";
import { PythonAdapter } from "../python-adapter.ts";
import { ensureScraplingVenv } from "../venv-setup.ts";

// ── Helpers ──

/**
 * Mock ensureVenv that returns a Python path without setting up anything.
 * Injected as the 4th constructor arg to bypass venv creation in tests.
 */
export async function mockEnsureVenv(_exec: ExecFn, cwd: string): Promise<string> {
	return `${cwd}/.pi/scrapling-venv/bin/python3`;
}

export interface SetupTestResult {
	cwd: string;
	exec: ReturnType<typeof mock.fn<ExecFn>>;
}

export interface SetupTestOptions {
	crawlStdout?: string;
	crawlCode?: number;
	killed?: boolean;
	signal?: string;
}

/**
 * Create temp dir + wrapped mock exec + PythonAdapter with mock ensureVenv.
 *
 * @param crawlStdout - What the subprocess stdout should return (defaults to valid crawl JSON)
 * @param crawlCode - Exit code for the subprocess (default 0)
 * @returns { cwd, exec, adapter }
 */
export function setupTest(
	crawlStdout?: string,
	crawlCode = 0,
	options?: SetupTestOptions,
): SetupTestResult & { adapter: PythonAdapter } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "python-adapter-test-"));
	const execFn: ExecFn = async (_cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
		const killed = options?.killed ?? false;
		const signal = options?.signal;
		return {
			code: crawlCode,
			stdout:
				crawlStdout ??
				JSON.stringify({
					ok: true,
					results: [
						{
							url: "https://example.com",
							markdown: "# Hello World",
							method: "lightweight",
							success: true,
						},
					],
				}),
			stderr: crawlCode !== 0 ? "Crawl process failed" : "",
			killed,
			...(signal ? { signal } : {}),
		};
	};
	const exec = mock.fn(execFn) as ReturnType<typeof mock.fn<ExecFn>>;
	const adapter = new PythonAdapter(exec, cwd, undefined, mockEnsureVenv);
	return { cwd, exec, adapter };
}
