// ── Tool metadata resolution ────────────────────────────────────
// Precedence: explicit config `toolMeta` > hardcoded `TOOL_META` (applied by
// the rules) > annotation-derived > generic default. Split out of
// agent-harness.ts (issue #2033): the class keeps the state machine, this keeps
// the lookup and its fail-open warning flag.

import { deriveToolMetaFromAnnotations } from "./tool-annotations.ts";
import type { ToolInfoProvider } from "./harness-types.ts";
import type { ResolvedHarnessRules, ToolMeta } from "./harness-rules.ts";

export interface ToolMetaLookup {
	/** Effective ToolMeta for a tool name. */
	get(toolName: string): ToolMeta;
	/** Re-arm the fail-open warning (called when the provider is replaced). */
	resetWarning(): void;
}

export function createToolMetaLookup(deps: {
	rules: () => ResolvedHarnessRules;
	provider: () => ToolInfoProvider | undefined;
}): ToolMetaLookup {
	let warningEmitted = false;

	/**
	 * Look up annotations via the injected port. Fail-open: a throwing provider
	 * must never convert into a fail-closed block (pi treats a `tool_call`
	 * handler throw as a block). Surfaced once, then silently ignored.
	 */
	function derive(toolName: string): ToolMeta | undefined {
		const provider = deps.provider();
		if (!provider) return undefined;
		try {
			const info = provider().find((t) => t.name === toolName);
			if (!info) return undefined;
			return deriveToolMetaFromAnnotations(info.annotations, deps.rules().cascadeThreshold);
		} catch (e) {
			if (!warningEmitted) {
				warningEmitted = true;
				console.error(
					`agent-harness: tool annotation lookup failed — using default rules (${(e as Error).message})`,
				);
			}
			return undefined;
		}
	}

	return {
		get(toolName: string): ToolMeta {
			const explicit = deps.rules().toolMeta[toolName];
			if (explicit) return explicit;

			const derived = derive(toolName);
			if (derived) return derived;

			return {
				passThrough: false,
				trackErrors: true,
				cascadeThreshold: deps.rules().cascadeThreshold,
			};
		},
		resetWarning(): void {
			warningEmitted = false;
		},
	};
}
