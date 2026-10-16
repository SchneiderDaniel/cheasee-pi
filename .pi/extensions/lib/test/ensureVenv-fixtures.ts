// ─── ensureVenv test fixtures (issue #2005 Long File split) ───
// Shared mock-exec factory and test setup moved out of ensureVenv.test.ts.
// Non-test module so `node --test` does not load it as a suite.

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureVenv, EnsureVenvError } from "../ensureVenv.ts";
import type { ExecFn } from "../port-types.ts";
import type { EnsureVenvConfig } from "../ensureVenv.ts";

/**
 * Helper: get the lock dir path as created by proper-lockfile.
 * proper-lockfile appends ".lock" to the base path returned by lockFilePathFor.
 * Currently we construct this identically to the old lockDirFor (same path suffix).
 */
export function lockDirPath(cwd: string, venvName: string): string {
	const safe = venvName.replace(/[^a-zA-Z0-9_-]/g, "_");
	return path.join(cwd, ".pi", `ensureVenv.${safe}.lock`);
}

// ── Mock exec factory ──

export interface MockHandlers {
	/** exec(pythonPath, ["-c", verifyCommand]) — quick/double-check verify */
	verify?: { code: number; stdout: string; stderr: string };
	/** exec("python3", ["-m", "venv", ...]) — venv creation */
	create?: { code: number; stdout: string; stderr: string };
	/** exec(pythonPath, ["-m", "pip", "install", ...]) — pip install */
	install?: { code: number; stdout: string; stderr: string };
	/** exec(pythonPath, ["-m", "scrapling.cli", ...]) — scrapling post-install */
	postInstall?: { code: number; stdout: string; stderr: string };
	/** catch-all for any unhandled command */
	default?: { code: number; stdout: string; stderr: string };
}

export interface MockCallbacks {
	onVerify?: (args: string[]) => void;
	onCreate?: (args: string[]) => void;
	onInstall?: (args: string[]) => void;
	onPostInstall?: (args: string[]) => void;
	onRm?: (args: string[]) => void;
	onAny?: (cmd: string, args: string[]) => void;
}

export const DEFAULT_HANDLERS: Required<MockHandlers> = {
	verify: { code: 1, stdout: "", stderr: "not found" },
	create: { code: 0, stdout: "", stderr: "" },
	install: { code: 0, stdout: "", stderr: "" },
	postInstall: { code: 0, stdout: "", stderr: "" },
	default: { code: 1, stdout: "", stderr: "mock: unhandled" },
};

export function makeMockExec(handlers: MockHandlers = {}, callbacks: MockCallbacks = {}): ExecFn {
	const merged: Required<MockHandlers> = { ...DEFAULT_HANDLERS, ...handlers };
	/** Whether the test explicitly provided a verify handler. */
	const hasCustomVerify = "verify" in handlers;
	/** Stateful: after venv is set up (create/install), verify passes. */
	let setupDone = false;

	return async (cmd: string, args: string[]) => {
		callbacks.onAny?.(cmd, args);

		// exec(pythonPath, ["-c", ...]) — verify check
		if (cmd.includes("bin/python3") && args[0] === "-c") {
			callbacks.onVerify?.(args);
			// After venv is set up, return success unless test provided custom verify
			if (setupDone && !hasCustomVerify) {
				return { code: 0, stdout: "ok", stderr: "" };
			}
			return merged.verify;
		}

		// exec("rm", ["-rf", ...]) — cleanup
		if (cmd === "rm" && args[0] === "-rf") {
			callbacks.onRm?.(args);
			return { code: 0, stdout: "", stderr: "" };
		}

		// exec("python3", ["-m", "venv", ...]) — create venv
		if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
			callbacks.onCreate?.(args);
			// Simulate venv directory structure so pythonPath exists
			const venvPath = args[args.length - 1];
			try {
				fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
				fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
			} catch {
				// Already exists or parallel test
			}
			const result = merged.create;
			if (result.code === 0) setupDone = true;
			return result;
		}

		// exec(pythonPath, ["-m", "pip", "install", ...]) — pip install
		if (cmd.includes("bin/python3") && args[0] === "-m" && args[1] === "pip") {
			callbacks.onInstall?.(args);
			const result = merged.install;
			if (result.code === 0) setupDone = true;
			return result;
		}

		// exec(pythonPath, ["-m", "scrapling.cli", ...]) — post-install
		if (cmd.includes("bin/python3") && args[0] === "-m" && args[1] === "scrapling.cli") {
			callbacks.onPostInstall?.(args);
			return merged.postInstall;
		}

		return merged.default;
	};
}

// ── Test setup ──

export interface TestConfig {
	handlers?: MockHandlers;
	callbacks?: MockCallbacks;
	config?: Partial<EnsureVenvConfig>;
}

export interface TestContext {
	cwd: string;
	exec: ReturnType<typeof mock.fn<ExecFn>>;
}

export function setupTest(opts: TestConfig = {}): TestContext {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ensureVenv-test-"));

	const execFn = makeMockExec(opts.handlers, opts.callbacks);
	const exec = mock.fn(execFn) as ReturnType<typeof mock.fn<ExecFn>>;

	return { cwd, exec };
}

export function makeConfig(
	ctx: TestContext,
	overrides: Partial<EnsureVenvConfig> = {},
): EnsureVenvConfig {
	return {
		exec: ctx.exec,
		cwd: ctx.cwd,
		venvName: "test-venv",
		pipArgs: ["test-pkg"],
		verifyCommand: "import test; print('ok')",
		...overrides,
	};
}

export interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

export function makeDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export function pathExists(p: string): boolean {
	try {
		fs.statSync(p);
		return true;
	} catch {
		return false;
	}
}
