/**
 * capture-core.ts — Captured output container + exec fixture registry.
 *
 * Split out of capture.ts (issue #2001). Owns the shared `CapturedOutput`
 * instance every mock writes into and the (cmd, args) fixture registry that
 * `createMockPi`'s `exec()` consults.
 */

import type { ExecResult } from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════════════
// Captured Output Types
// ═══════════════════════════════════════════════════════════════════════

/** A single call to pi.sendMessage() with its options. */
export interface CapturedMessage {
	customType: string;
	content: string | Array<{ type: string; text?: string }>;
	display?: boolean;
	details?: unknown;
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** A single call to ctx.ui.setWidget(). */
export interface CapturedWidget {
	id: string;
	lines?: string[];
}

/** A single call to ctx.ui.setStatus(). */
export interface CapturedStatus {
	key: string;
	text?: string;
}

/** A single call to ctx.ui.notify(). */
export interface CapturedNotification {
	msg: string;
	type?: "info" | "warning" | "error";
}

/** A single call to pi.exec(). */
export interface CapturedExecCall {
	cmd: string;
	args: string[];
}

/**
 * Container for all captured terminal and GitHub output.
 *
 * Create one instance per test in beforeEach() to prevent
 * cross-test ordering dependencies from shared mutable arrays.
 */
export class CapturedOutput {
	messages: CapturedMessage[] = [];
	widgets: CapturedWidget[] = [];
	statuses: CapturedStatus[] = [];
	notifications: CapturedNotification[] = [];
	execCalls: CapturedExecCall[] = [];
}

// ═══════════════════════════════════════════════════════════════════════
// ExecResult Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Construct a valid pi-coding-agent ExecResult shape.
 *
 * Unspecified fields default to:
 * - stdout: ""
 * - stderr: ""
 * - code: 0
 * - killed: false
 *
 * Use this in test fixtures to ensure ExecResult matches
 * what production code actually receives.
 */
export function makeExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
	return {
		stdout: "",
		stderr: "",
		code: 0,
		killed: false,
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Fixture Registry
// ═══════════════════════════════════════════════════════════════════════
//
// Module-level registry so createMockPi's exec() can look up pre-registered
// responses. Reset in beforeEach() via resetMocks().

const fixtureRegistry = new Map<string, ExecResult>();

/**
 * Register a single exec response for a specific (cmd, args) pair.
 *
 * The lookup key is `${cmd} ${args.join(" ")}`.
 * Use `setMockResponses()` to register multiple at once.
 */
export function mockExecResponse(cmd: string, args: string[], result: ExecResult): void {
	fixtureRegistry.set(keyFor(cmd, args), result);
}

/**
 * Register multiple exec responses at once.
 *
 * Keys are `${cmd} ${args.join(" ")}` strings.
 * For commands with varying arguments, use `"*"` as the args part to match any args.
 *
 * @example
 * ```ts
 * setMockResponses({
 *   "gh issue view 123": makeExecResult({ stdout: "issue body" }),
 *   "gh issue view *":   makeExecResult({ stdout: "fallback" }),
 * });
 * ```
 */
export function setMockResponses(map: Record<string, ExecResult>): void {
	for (const [key, result] of Object.entries(map)) {
		fixtureRegistry.set(key, result);
	}
}

/**
 * Clear all registered exec fixtures.
 *
 * Call in beforeEach() to prevent cross-test leakage of exec responses.
 */
export function resetMocks(): void {
	fixtureRegistry.clear();
}

/** Build the lookup key for a (cmd, args) pair. */
function keyFor(cmd: string, args: string[]): string {
	return `${cmd} ${args.join(" ")}`;
}

/**
 * Look up a registered fixture for (cmd, args).
 *
 * Resolution order:
 * 1. Exact match on `${cmd} ${args.join(" ")}`
 * 2. Wildcard match: iterate registered keys, treat `*` as match-any
 * 3. Return undefined (caller gets default error result)
 */
export function lookupExecFixture(cmd: string, args: string[]): ExecResult | undefined {
	const needle = keyFor(cmd, args);

	// 1. Exact match
	const exact = fixtureRegistry.get(needle);
	if (exact !== undefined) return exact;

	// 2. Wildcard — iterate keys and check glob-style match
	for (const [key, result] of fixtureRegistry) {
		if (globMatch(needle, key)) {
			return result;
		}
	}

	// 3. No match
	return undefined;
}

/**
 * Simple glob match: `*` matches any sequence of characters (including empty).
 * No other glob syntax is supported.
 */
function globMatch(input: string, pattern: string): boolean {
	if (!pattern.includes("*")) {
		return input === pattern;
	}
	const parts = pattern.split("*");
	let pos = 0;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === "") continue; // leading/trailing/multiple wildcards
		const idx = input.indexOf(part, pos);
		if (idx === -1) return false;
		pos = idx + part.length;
	}
	return true;
}

export type { ExecResult };
