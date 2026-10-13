/**
 * Shared harness for the rtk version-gate suites.
 *
 * Replaces the duplicated preamble in version-gate.test.ts and
 * version-gate-lifecycle.test.ts (the latter's own header says "Same harness
 * preamble"): the fake pi, the ExecResult factories, the call filters, the
 * event dispatchers, the enabled-pi fixture and the console.warn capture pair.
 *
 * Test scaffolding only; never imported by production code.
 */

import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import factory from "../index.ts";

export type Handler = (event: any, ctx: any) => any;
export type ExecImpl = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export interface FakePi {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	calls: { cmd: string; args: string[]; opts?: ExecOptions }[];
}

/** Fake pi that records exec calls and registers handlers by event name. */
export function makePi(execImpl: ExecImpl): FakePi {
	const handlers = new Map<string, Handler[]>();
	const calls: { cmd: string; args: string[]; opts?: ExecOptions }[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		async exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
			calls.push({ cmd, args, opts });
			return execImpl(cmd, args, opts);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, calls };
}

export function ok(stdout: string): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

export function fail(code: number, stdout = "", stderr = ""): ExecResult {
	return { stdout, stderr, code, killed: false };
}

export function killedProbe(): ExecResult {
	return { stdout: "", stderr: "", code: null as unknown as number, killed: true };
}

export function deferred<T>() {
	let resolveFn!: (v: T) => void;
	let rejectFn!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolveFn = res;
		rejectFn = rej;
	});
	return { promise, resolve: resolveFn, reject: rejectFn };
}

export const versionCalls = (f: FakePi) => f.calls.filter((c) => c.args[0] === "--version");
export const rewriteCalls = (f: FakePi) => f.calls.filter((c) => c.args[0] === "rewrite");

export async function fireSessionStart(f: FakePi): Promise<void> {
	for (const h of f.handlers.get("session_start") ?? []) {
		await h({ type: "session_start", reason: "startup" }, {});
	}
}

export async function fireBash(f: FakePi, command: string): Promise<any> {
	const event: any = {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "bash",
		input: { command },
	};
	for (const h of f.handlers.get("tool_call") ?? []) {
		await h(event, {});
	}
	return event;
}

/** Fresh fake pi whose gate is probed via `session_start`. */
export async function enabledPi(execImpl: ExecImpl): Promise<FakePi> {
	const f = makePi(execImpl);
	await factory(f.pi);
	await fireSessionStart(f);
	return f;
}

/** Console.warn capture buffer; reset by captureWarnings and read by tests. */
export const warnings: unknown[][] = [];
let originalWarn: typeof console.warn;

/** Starts capturing console.warn into `warnings`. Pair with restoreWarnings. */
export function captureWarnings(): void {
	warnings.length = 0;
	originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args);
	};
}

/** Restores the console.warn the capture replaced. */
export function restoreWarnings(): void {
	console.warn = originalWarn;
}

export function warnText(): string {
	return warnings.map((w) => w.map(String).join(" ")).join("\n");
}
