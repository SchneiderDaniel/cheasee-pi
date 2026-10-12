// ─── web-search test fixtures (issue #2005 Long File split) ───
// Shared mock-exec helpers moved out of index.test.ts. Non-test module so
// `node --test` does not load it as a suite.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExecFn, ExecResult } from "../types.ts";
import webSearch from "../index.ts";
import { FRAME } from "../protocol.ts";

// ── Mock exec helpers ──

/** Return the same ExecResult for every call */
export function mockExecReturns(result: ExecResult): ExecFn {
	return async () => result;
}

/** Return ExecResults in sequence, repeating the last result for extra calls */
export function mockExecSequence(results: ExecResult[]): ExecFn {
	let i = 0;
	return async () =>
		results[i++] ?? results[results.length - 1] ?? { code: 0, stdout: "", stderr: "" };
}

/** Frame a payload the way the Python producer does: <RS><json><RS> */
export const framed = (payload: unknown): string => `${FRAME}${JSON.stringify(payload)}${FRAME}`;

/**
 * Mock: non-bash calls (venv verify) pass; bash is the search script. Captures the
 * script config file read at call time.
 */
export function execReturning(results: Array<{ title: string; url: string; snippet: string }>): {
	exec: ExecFn;
	config: () => any;
} {
	let captured: any;
	const exec: ExecFn = async (cmd, args) => {
		if (cmd === "bash") {
			const m = args[1].match(/'([^']*config\.json)'/);
			if (m) captured = JSON.parse(fs.readFileSync(m[1], "utf-8"));
			return { code: 0, stdout: framed({ ok: true, results }), stderr: "" };
		}
		return { code: 0, stdout: "ok", stderr: "" };
	};
	return { exec, config: () => captured };
}

// ── Test helper: register the real webSearch tool with a mock pi.exec ──

export interface MockPi {
	registerTool: (tool: any) => void;
	exec: ExecFn;
}

export function registerWebSearch(mockExec: ExecFn): any {
	let tool: any;
	const mockPi: MockPi = {
		registerTool: (t: any) => {
			tool = t;
		},
		exec: mockExec,
	};
	webSearch(mockPi as any);
	return tool;
}

/** Temp directory for test cwds so ensureVenv can create .pi/. */
export const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-search-test-"));
export const tmp = (name: string) => path.join(tmpDir, name);

// ===========================================================================
// Module exports
// ===========================================================================
