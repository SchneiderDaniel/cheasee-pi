/**
 * LSP client runtime seam + timing primitives.
 *
 * Holds the entire mutable injection seam in one module:
 * currentRuntime + setLspRuntime/resetLspRuntime/getRuntime, plus the
 * default production runtime (createDefaultRuntime) and timing helpers
 * (withTimeout, sleep). This is the only module in the LSP client with
 * Node I/O + external dependency (vscode-jsonrpc) wiring.
 *
 * Tests inject a mock LspRuntime to replace Node I/O and vscode-jsonrpc,
 * eliminating the need for --experimental-test-module-mocks and mock.module().
 *
 * Fixes:
 * - C4 P1: jsonRpcModule cached inside loadJsonRpc() function scope (not module-level)
 */

import { spawn as realSpawn, execFile as realExecFile } from "node:child_process";
import { existsSync as realExistsSync } from "node:fs";
import { readFile as realReadFile } from "node:fs/promises";
import type { LspRuntime, JsonRpcModule } from "../types.ts";

// ─── Injection Seam ──────────────────────────────────────────────────

/** Current injected runtime, or undefined for default (production) behavior */
let currentRuntime: LspRuntime | undefined;

/**
 * Override the default runtime with a custom LspRuntime.
 * Used by tests to inject canned implementations without module mocking.
 *
 * @internal - Test injection seam. Only call from test files.
 * @param runtime - LspRuntime to use
 * @throws TypeError if runtime is undefined
 */
export function setLspRuntime(runtime: LspRuntime): void {
	if (runtime === undefined) {
		throw new TypeError("setLspRuntime requires an LspRuntime argument");
	}
	currentRuntime = runtime;
}

/**
 * Reset the injected runtime to use the default production implementation.
 * Must be called in afterEach to prevent cross-test bleed.
 *
 * @internal - Test injection seam. Only call from test files.
 */
export function resetLspRuntime(): void {
	currentRuntime = undefined;
}

/**
 * Get the current runtime — injected or default.
 *
 * @internal - Imported by audit-group.ts so the orchestrator observes the
 * injected state; duplicating the variable in another module would silently
 * corrupt test injection.
 */
export function getRuntime(): LspRuntime {
	return currentRuntime ?? createDefaultRuntime();
}

/**
 * Create the default production LspRuntime backed by real Node modules.
 * Closure-based: each call creates an independent instance with its own
 * jsonRpcModule cache.
 */
export function createDefaultRuntime(): LspRuntime {
	let jsonRpcModule: JsonRpcModule | null = null;

	return {
		spawn: (command, args, options) => realSpawn(command, args, options) as any,
		execFile: (
			file: string,
			args: string[],
			options: Record<string, unknown>,
			callback: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			realExecFile(file, args, options as Record<string, unknown>, callback);
		},
		existsSync: (path) => realExistsSync(path),
		readFile: (path, encoding) => (realReadFile as any)(path, encoding),
		loadJsonRpc: async () => {
			if (jsonRpcModule) return jsonRpcModule;
			try {
				jsonRpcModule = (await import("vscode-jsonrpc")) as unknown as JsonRpcModule;
				return jsonRpcModule;
			} catch {
				return null;
			}
		},
	};
}

// ─── Timing Primitives ───────────────────────────────────────────────

/**
 * Promise with timeout — guarded against unhandled rejections from losing promise.
 *
 * Resolves null on timeout. Uses a settled flag so the losing settlement is
 * silently absorbed — prevents unhandled rejections when connection.dispose()
 * rejects a timed-out sendRequest promise (issue #247), while still propagating
 * rejections that occur before the timeout fires.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let settled = false;
	return new Promise<T | null>((resolve, reject) => {
		promise.then(
			(val) => {
				if (!settled) {
					settled = true;
					resolve(val);
				}
			},
			(err) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
			},
		);
		setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(null);
			}
		}, ms);
	});
}

/** Sleep for ms milliseconds */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
