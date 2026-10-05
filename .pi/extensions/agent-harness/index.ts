/**
 * agent-harness — Runtime Tool Call Validation Extension
 *
 * Re-exports AgentHarness class from agent-harness.ts.
 * The default export registers pi event handlers using AgentHarness.
 *
 * @packageDocumentation
 */

import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { AgentHarness } from "./agent-harness.ts";
import type { ToolInfoProvider } from "./agent-harness.ts";
import type { ToolInfoLike } from "./lib/tool-annotations.ts";
import { loadProjectConfig, loadDefaultRules } from "./lib/load-config.ts";
import type { ConfigLoaderContext } from "./lib/load-config.ts";

export { AgentHarness, getBashSubKey } from "./agent-harness.ts";
export type { ToolCallResult } from "./agent-harness.ts";
export type { ResolvedHarnessRules } from "./agent-harness.ts";
export { loadProjectConfig } from "./lib/load-config.ts";

/**
 * Surface a config-load failure mode-adaptively (mirrors format-on-save):
 * TUI → ctx.ui.notify, RPC → pi.sendUserMessage, JSON/print/unknown → console.error.
 */
function notifyConfigFailure(pi: ExtensionAPI, ctx: ConfigLoaderContext, message: string): void {
	const text = `agent-harness: ${message} — using default rules`;
	if (ctx.mode === "tui" && typeof ctx.ui?.notify === "function") {
		ctx.ui.notify(text, "warning");
	} else if (ctx.mode === "rpc") {
		pi.sendUserMessage(text, { deliverAs: "followUp" });
	} else {
		console.error(text);
	}
}

/**
 * Build the tool-info port closure over `pi.getAllTools()`.
 *
 * Feature-detects the API: on pi floors without it the provider yields `[]`,
 * so annotation-derived defaults simply never apply and legacy behavior holds.
 * `getAllTools()` returns all *registered* tools (including inactive ones) — the
 * harness only uses the map as a fallback table, so that is harmless.
 */
function buildToolInfoProvider(pi: ExtensionAPI): ToolInfoProvider {
	const getAllTools = (pi as { getAllTools?: unknown }).getAllTools;
	if (typeof getAllTools !== "function") {
		return () => [];
	}
	return () => {
		const tools = (getAllTools as () => unknown).call(pi);
		return Array.isArray(tools) ? (tools as ToolInfoLike[]) : [];
	};
}

// ── Extension entry point ──

export default function agentHarness(pi: ExtensionAPI): void {
	const harness = new AgentHarness();

	// Session start: initialize fresh state and load project config
	pi.on("session_start", async (_data: unknown, ctx: unknown) => {
		harness.reset();
		// Annotations are resolved lazily per tool_call — no session snapshot.
		harness.setToolInfoProvider(buildToolInfoProvider(pi));
		const configCtx = (ctx ?? {}) as ConfigLoaderContext;
		// Derive project root from ctx if available (for testability)
		const projectRoot = configCtx.sessionManager?.getCwd?.();
		try {
			const rules = loadProjectConfig(configCtx, projectRoot);
			harness.setRules(rules);
		} catch (e) {
			// Fail-safe: discard the failed config, fall back to defaults, but never silently drop it.
			// Without resetting the rules here, a previous session's config would leak into this one.
			harness.setRules(loadDefaultRules());
			notifyConfigFailure(pi, configCtx, (e as Error).message);
		}
	});

	// Turn start: increment session turn, reset cascade counter, decay error tracker
	pi.on("turn_start", async () => {
		harness.handleTurnStart();
	});

	// Tool_call handler
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | void> => {
		return harness.handleToolCall(event, ctx) ?? undefined;
	});
}
