/**
 * /caveman command handler and settings dialog
 *
 * UI at the edge — depends on all other modules + pi-tui widgets.
 * Extracted from main function, no singleton capture.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ConfigStore } from "./config.ts";
import type { Level } from "./types.ts";
import { LEVELS, STOP_ALIASES, CAVEMAN_COMMAND_OPTIONS } from "./types.ts";
import { shouldLightenCompression } from "./compression.ts";

import { openConfigDialog } from "./config-ui.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maximum length for a single file path display to avoid flooding the UI.
 */
const MAX_FILE_DISPLAY = 60;

/**
 * Maximum number of file paths to show before truncating.
 */
const MAX_FILES_SHOWN = 5;

/**
 * Build a status message from the current system prompt options.
 */
function buildStatusMessage(ctx: ExtensionCommandContext): string {
	try {
		const options = ctx.getSystemPromptOptions();
		if (!options) {
			return "Caveman status: Prompt options unavailable.";
		}

		const parts: string[] = [];

		// Active tools
		const tools = options.selectedTools;
		if (tools && tools.length > 0) {
			parts.push(`Active tools: ${tools.join(", ")}`);
			if (shouldLightenCompression(options)) {
				parts.push("• Structured search tools detected — compression will be lighter");
			}
		} else {
			parts.push("No active tools.");
		}

		// Context files — truncate for display safety
		const files = options.contextFiles;
		if (files && files.length > 0) {
			const totalFiles = files.length;
			const shownFiles = files.slice(0, MAX_FILES_SHOWN);
			const fileList = shownFiles
				.map((f) => {
					const path =
						f.path.length > MAX_FILE_DISPLAY
							? "..." + f.path.slice(-(MAX_FILE_DISPLAY - 3))
							: f.path;
					return `  • ${path}`;
				})
				.join("\n");
			parts.push(`Context files (${totalFiles}):\n${fileList}`);
			if (totalFiles > MAX_FILES_SHOWN) {
				parts.push(`  ... and ${totalFiles - MAX_FILES_SHOWN} more`);
			}
		} else {
			parts.push("No context files.");
		}

		return `Caveman status:\n${parts.join("\n")}`;
	} catch {
		return "Caveman status: Unable to read prompt options.";
	}
}

/**
 * Register the /caveman command and wire its handler.
 */
export function registerCavemanCommand(
	pi: ExtensionAPI,
	configStore: ConfigStore,
	syncStatus: (ctx: Pick<ExtensionContext, "ui">) => void,
): void {
	pi.registerCommand("caveman", {
		description:
			"Toggle caveman mode, set level, use off/stop/quit to disable, 'status' to inspect prompt context, or 'config' to open settings",
		getArgumentCompletions: (prefix: string) => {
			const normalized = prefix.trim().toLowerCase();
			const items = CAVEMAN_COMMAND_OPTIONS.filter((item) => item.value.startsWith(normalized));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();

			// Open config dialog
			if (arg === "config") {
				await openConfigDialog(ctx, configStore, syncStatus);
				return;
			}

			// Show status with system prompt options
			if (arg === "status") {
				const msg = buildStatusMessage(ctx);
				ctx.ui.notify(msg, "info");
				return;
			}

			if (!arg) {
				// Toggle: off → full, anything else → off
				const current = configStore.getLevel();
				configStore.setLevel(current === "off" ? "full" : "off");
			} else if (STOP_ALIASES.has(arg)) {
				configStore.setLevel("off");
			} else if (LEVELS.includes(arg as Level)) {
				configStore.setLevel(arg as Level);
			} else {
				ctx.ui.notify(
					`Unknown: "${arg}". Use: ${LEVELS.join(", ")}, stop, quit, status, or config`,
					"error",
				);
				return;
			}

			const level = configStore.getLevel();
			pi.appendEntry("caveman-level", { level });
			syncStatus(ctx);

			ctx.ui.notify(level === "off" ? "Caveman off" : `Caveman: ${level.toUpperCase()}`, "info");
		},
	});
}
