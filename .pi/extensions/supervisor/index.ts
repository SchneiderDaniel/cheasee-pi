/**
 * Supervisor — Kanban-driven multi-agent workflow for GitHub issues
 *
 * Manages issue lifecycle through Research → Architecture → TestDesign
 * → Implementation → Audit stages. Assigns specialized sub-agents per
 * stage based on status transitions in GitHub projects.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMessageRenderer, createSummaryRenderer } from "./session/message-renderer";
import { registerSupervisorCommand } from "./pipeline/index.ts";
import { createIssueAutocompleteProvider, resetIssueCache } from "./event/autocomplete.ts";
import { loadConfig } from "./config/config.ts";
import { registerSubagentTool } from "./subagent/index.ts";

export default function supervisor(pi: ExtensionAPI) {
	pi.registerMessageRenderer("supervisor", createMessageRenderer(pi));
	pi.registerMessageRenderer("supervisor-summary", createSummaryRenderer(pi));
	pi.registerMessageRenderer("supervisor-progress", createMessageRenderer(pi));
	registerSupervisorCommand(pi);

	// Register subagent tool for native inline rendering per agent step
	// Enables both LLM-callable subagent (Step 3 bonus) and pipeline-integrated
	// execution via executeSubagent() exported from ./subagent/index.ts
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
