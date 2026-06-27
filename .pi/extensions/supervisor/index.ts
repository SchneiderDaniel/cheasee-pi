/**
 * Supervisor — Kanban-driven multi-agent workflow for GitHub issues
 *
 * Manages issue lifecycle through Research → Architecture → TestDesign
 * → Implementation → Audit stages. Assigns specialized sub-agents per
 * stage based on status transitions in GitHub projects.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createMessageRenderer, createSummaryRenderer } from "./session/message-renderer";
import { registerSupervisorCommand } from "./pipeline/index.ts";
import { createIssueAutocompleteProvider, resetIssueCache } from "./event/autocomplete.ts";
import { loadConfig } from "./config/config.ts";
import { registerSubagentTool } from "./subagent/index.ts";

// ── Session memory cleanup on compaction ────────────────────────
// After compaction, entries before firstKeptEntryId are persisted to disk
// and genuinely skipped by buildSessionContext() (they're in the parentId
// chain walk but excluded from messages). Null their payloads to free heap.
import { SessionManager } from "@earendil-works/pi-coding-agent";
{
	const origAppendCompaction = SessionManager.prototype.appendCompaction;
	SessionManager.prototype.appendCompaction = function (
		summary: any,
		firstKeptEntryId: string,
		tokensBefore: any,
		details: any,
		fromHook: any,
	) {
		const result = origAppendCompaction.call(
			this,
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		);
		// Null content for entries before firstKeptEntryId — skipped by
		// buildSessionContext(). Keep shell (id, parentId) for chain walk.
		if (firstKeptEntryId) {
			for (const e of (this as any).fileEntries) {
				if (e.id === firstKeptEntryId) break;
				if (e.type === "message" && e.message) {
					e.message.content = undefined;
					e.message.toolCalls = undefined;
					e.message.toolResults = undefined;
				}
			}
		}
		return result;
	};
}

// ── pi.executeTool augmentation (no pi-core changes) ──────────────
// Type augmentation so TypeScript recognizes pi.executeTool() on ExtensionAPI.
declare module "@earendil-works/pi-coding-agent" {
	interface ExtensionAPI {
		executeTool(
			toolName: string,
			params: Record<string, unknown>,
			options?: { signal?: AbortSignal; onUpdate?: (result: any) => void },
		): Promise<any>;
	}
}

export default function supervisor(pi: ExtensionAPI) {
	// Intercept registerTool to capture execute functions for programmatic dispatch.
	// This avoids modifying pi-core's node_modules while enabling the pipeline
	// to call pi.executeTool("subagent", params, { onUpdate }).
	const toolExecutors = new Map<string, Function>();
	const origRegisterTool = pi.registerTool.bind(pi);
	pi.registerTool = ((tool: ToolDefinition) => {
		if (tool.execute) toolExecutors.set(tool.name, tool.execute as Function);
		origRegisterTool(tool);
	}) as typeof pi.registerTool;

	(pi as any).executeTool = async (
		toolName: string,
		params: Record<string, unknown>,
		options?: { signal?: AbortSignal; onUpdate?: (result: any) => void },
	) => {
		const execute = toolExecutors.get(toolName);
		if (!execute) throw new Error(`Tool "${toolName}" not found — not yet registered`);
		const toolCallId = `pi_exec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
		return execute(toolCallId, params, options?.signal, options?.onUpdate, undefined);
	};

	pi.registerMessageRenderer("supervisor", createMessageRenderer(pi));
	pi.registerMessageRenderer("supervisor-summary", createSummaryRenderer(pi));
	// supervisor-progress renderer removed — widget-based progress replaces invisible sendMessage.
	registerSupervisorCommand(pi);

	registerSubagentTool(pi);

	// Register #-trigger autocomplete provider for issue numbers
	// The session_start handler receives ExtensionContext which has ctx.ui
	pi.on("session_start", async (_event, ctx) => {
		// Reset the module-level cache so fresh issues are fetched
		resetIssueCache();

		try {
			const config = loadConfig();
			const execFn = (cmd: string, args: string[]) => pi.exec(cmd, args);

			// Register the autocomplete provider via ctx.ui (ExtensionContext, not ExtensionAPI)
			ctx.ui.addAutocompleteProvider(createIssueAutocompleteProvider(config, execFn));
		} catch {
			// Supervisor not configured — skip autocomplete registration silently
		}
	});
}
