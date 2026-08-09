/**
 * Shared test helpers for the worktree-sandbox extension.
 *
 * Eliminates three duplication families across the 4 test files:
 * 1. Cross-file helper duplication — makePathEvent, makeToolCallEvent, makeCtx, makeMockPi
 * 2. Intra-file try/finally env boilerplate — withSandboxEnv
 * 3. Intra-file tool triplicate assertion boilerplate — assertBlocksOutside, assertPassesThrough
 *
 * Exports a small interface (Deep Module pattern) that hides internals
 * while remaining composable for individual test scenarios.
 */

import assert from "node:assert/strict";
import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────

export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface MockCtx {
	hasUI: boolean;
	ui: { notify: (message: string, type?: string) => void };
	mode: string | undefined;
	isProjectTrusted?: () => boolean | undefined;
	[key: string]: unknown;
}

export interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

// ─── Event factories ───────────────────────────────────────────────

/**
 * Create a simplified event for testing rewritePath() directly.
 * Shape: { input: { path } }
 */
export function makePathEvent(path: string): { input: { path: string } } {
	return { input: { path } };
}

/**
 * Create a full tool call event for testing handler registration.
 * Shape: { type: "tool_call", toolCallId, toolName, input }
 */
export function makeToolCallEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolCallId: "test-call-id", toolName, input };
}

// ─── Context factory ───────────────────────────────────────────────

/**
 * Create a mock extension context with notification tracking.
 *
 * The produced ctx has:
 * - `hasUI` (default false), `mode` (default "tui"), `isProjectTrusted` (default () => true)
 * - `ui.notify` that pushes to an internal `_notifications` array
 * - `_notifications` array exposed for test assertions
 *
 * Overrides are spread on top of defaults, but `_notifications` is always a fresh array
 * (not overridable) to ensure test isolation.
 */
export function makeCtx(overrides: Partial<MockCtx> = {}): MockCtx {
	const notifications: Array<{ msg: string; level?: string }> = [];
	const ctx: MockCtx = {
		hasUI: false,
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ msg: message, level: type });
			},
		},
		mode: "tui",
		isProjectTrusted: () => true,
		...overrides,
		_notifications: notifications,
	};
	return ctx;
}

// ─── Mock Pi factory ───────────────────────────────────────────────

/**
 * Create a mock ExtensionAPI for testing handler registration.
 *
 * Returns { on, handlers } where:
 * - `on(event, handler)` registers a handler into the `handlers` Map keyed by event name
 * - `handlers` is a Map that test code can use to retrieve and invoke registered handlers
 */
export function makeMockPi(): {
	on: (
		event: string,
		handler: (event: ToolCallEvent, ctx: MockCtx) => Promise<ToolCallResult | undefined>,
	) => void;
	handlers: Map<
		string,
		(event: ToolCallEvent, ctx: MockCtx) => Promise<ToolCallResult | undefined>
	>;
} {
	const handlers = new Map<
		string,
		(event: ToolCallEvent, ctx: MockCtx) => Promise<ToolCallResult | undefined>
	>();
	return {
		handlers,
		on: (
			event: string,
			handler: (event: ToolCallEvent, ctx: MockCtx) => Promise<ToolCallResult | undefined>,
		) => {
			handlers.set(event, handler);
		},
	};
}

// ─── Env lifecycle wrapper ─────────────────────────────────────────

/**
 * Execute a function with a process.env variable set, cleaning up in finally.
 *
 * Sets `process.env[key] = value` before invoking `fn`, then deletes
 * `process.env[key]` in a finally block. Returns the return value of `fn`.
 */
export async function withSandboxEnv<T>(
	key: string,
	value: string,
	fn: () => T | Promise<T>,
): Promise<T> {
	process.env[key] = value;
	try {
		return await fn();
	} finally {
		delete process.env[key];
	}
}

// ─── Assertion helpers for tool triplicate ─────────────────────────

type RewritePathFn = (
	toolName: "read" | "write" | "edit",
	event: { input: { path: string } },
	sandboxRoot: string,
	ctx: {
		hasUI: boolean;
		ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
	},
	blockNoun: "file operations" | "writes" | "edits",
) => ToolCallResult | undefined;

/**
 * Assert that rewritePath blocks a path with the expected block noun.
 *
 * Calls rewritePath(toolName, event, sandboxRoot, ctx, blockNoun) and verifies:
 * - result is not undefined
 * - result.block === true
 * - result.reason contains blockNoun
 */
export function assertBlocksOutside(
	rewritePath: RewritePathFn,
	toolName: "read" | "write" | "edit",
	path: string,
	sandboxRoot: string,
	blockNoun: "file operations" | "writes" | "edits",
	ctx: {
		hasUI: boolean;
		ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
	},
): void {
	const event = makePathEvent(path);
	const result = rewritePath(toolName, event, sandboxRoot, ctx, blockNoun);
	assert.ok(result !== undefined, `expected block result for ${toolName} with path "${path}"`);
	assert.equal(result.block, true);
	assert.ok((result.reason ?? "").includes(blockNoun), `expected reason to include "${blockNoun}"`);
}

/**
 * Assert that rewritePath passes through (returns undefined) for a path.
 *
 * Calls rewritePath(toolName, event, sandboxRoot, ctx, blockNoun) and verifies
 * result is undefined. For relative paths, also verifies event.input.path was mutated
 * by prepending sandboxRoot.
 */
export function assertPassesThrough(
	rewritePath: RewritePathFn,
	toolName: "read" | "write" | "edit",
	path: string,
	sandboxRoot: string,
	blockNoun: "file operations" | "writes" | "edits",
	ctx: {
		hasUI: boolean;
		ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
	},
): void {
	const event = makePathEvent(path);
	const result = rewritePath(toolName, event, sandboxRoot, ctx, blockNoun);
	assert.equal(result, undefined, `expected pass-through for ${toolName} with path "${path}"`);
	// For relative paths, verify mutation
	if (path && !path.startsWith("/")) {
		assert.equal(event.input.path, join(sandboxRoot, path));
	}
}
