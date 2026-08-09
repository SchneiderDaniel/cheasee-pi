// ─── Pipeline Entry ──────────────────────────────────────────────
// Thin entry: registerSupervisorCommand delegates to handler.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleSupervisorCommand } from "./handler.ts";

export function registerSupervisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("supervisor", {
		description:
			"Process a GitHub issue through the full Kanban pipeline. --debug to write JSONL logs to /tmp/",
		handler: async (args, ctx: ExtensionCommandContext) => {
			await handleSupervisorCommand(args, ctx, pi);
		},
	});
}
