/**
 * _guards.ts — Type guards for SessionEntry discriminated union
 *
 * Prevents the recurring bug class (#431, #1096) of filtering by
 * `e.toolName` without checking `e.type === "tool_use"`, which
 * inflates counts by including tool_result entries.
 *
 * Domain layer: zero pi dependencies, zero I/O.
 */

import type { SessionEntry } from "../types.ts";

/**
 * Narrow SessionEntry to tool_use with a defined toolName.
 * Use in filters where you want only actual tool-call entries.
 */
export function isToolUse(e: SessionEntry): e is SessionEntry & { type: "tool_use"; toolName: string } {
	return e.type === "tool_use" && !!e.toolName;
}

/**
 * Narrow SessionEntry to tool_use with toolName and args.
 * Use in filters that need both toolName and args (e.g. identical-args).
 */
export function isToolUseWithArgs(
	e: SessionEntry,
): e is SessionEntry & { type: "tool_use"; toolName: string; args: Record<string, unknown> } {
	return e.type === "tool_use" && !!e.toolName && !!e.args;
}
