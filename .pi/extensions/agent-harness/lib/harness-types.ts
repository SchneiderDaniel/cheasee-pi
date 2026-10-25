// ── Harness tool-call types ─────────────────────────────────────
// The pi-shaped event/context the harness validates against, and the result it
// returns. Split out of agent-harness.ts (issue #2033) so the per-guard modules
// can share them without importing the class module.

import type { ToolInfoLike } from "./tool-annotations.ts";

export interface ToolCallResult {
	block: boolean;
	reason: string;
	redirectTo?: string;
}

/**
 * Port for tool metadata. The pi adapter (index.ts) supplies a closure over
 * `pi.getAllTools()`; the harness stays pi-free. Resolved lazily on every
 * `tool_call` so later-registered tools are visible without a session snapshot.
 */
export type ToolInfoProvider = () => ReadonlyArray<ToolInfoLike>;

export interface ToolCallEvent {
	toolName?: string;
	input: Record<string, unknown>;
	isError?: boolean;
	toolCallId?: string;
	parentToolCallId?: string;
}

export interface ToolCallContext {
	sessionManager?: {
		getCwd?: () => string;
	};
	ui?: {
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};
	/** Context mode: "tui", "rpc", "json", "print", etc. */
	mode?: string;
	/** True if there is an interactive user to respond to prompts. */
	hasUI?: boolean;
	/** Check if the current project is trusted. Returns false when undefined. */
	isProjectTrusted?: () => boolean;
}
