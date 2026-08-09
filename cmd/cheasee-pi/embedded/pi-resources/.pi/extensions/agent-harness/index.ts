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
import { loadProjectConfig } from "./lib/load-config.ts";
import type { ConfigLoaderContext } from "./lib/load-config.ts";

export { AgentHarness, getBashSubKey } from "./agent-harness.ts";
export type { ToolCallResult } from "./agent-harness.ts";
export type { ResolvedHarnessRules } from "./agent-harness.ts";
export { loadProjectConfig } from "./lib/load-config.ts";

// ── Extension entry point ──

export default function agentHarness(pi: ExtensionAPI): void {
	const harness = new AgentHarness();

	// Session start: initialize fresh state and load project config
	pi.on("session_start", async (_data: unknown, ctx: unknown) => {
		harness.reset();
		try {
			const configCtx = (ctx ?? {}) as ConfigLoaderContext;
			// Derive project root from ctx if available (for testability)
			const projectRoot = configCtx.sessionManager?.getCwd?.();
			const rules = loadProjectConfig(configCtx, projectRoot);
			harness.setRules(rules);
		} catch {
			// Fail-safe: on config load failure, continue with defaults
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
