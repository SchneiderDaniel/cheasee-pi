/**
 * Caveman — Compresses AI responses into terse, no-fluff style
 *
 * Strips articles, filler, and pleasantries from all agent output.
 * Adjustable intensity via /caveman command.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createConfigStore } from "./config.ts";
import { registerCavemanCommand } from "./command.ts";
import {
	resolveSessionLevel,
	resetSessionLevel,
	shouldAppendCavemanEntry,
} from "../lib/extension-state.ts";
import { resolveCompression, shouldLightenCompression } from "./compression.ts";
import { CAVEMAN_BASE, INTENSITY } from "./prompts.ts";

export default function caveman(pi: ExtensionAPI): void {
	const configStore = createConfigStore();

	const syncStatus = (ctx: Pick<ExtensionContext, "ui">) => {
		const theme = ctx.ui.theme;
		const level = configStore.getLevel();
		const showStatus = configStore.getConfig().showStatus;

		if (level === "off" || !showStatus) {
			ctx.ui.setStatus("caveman", undefined);
			return;
		}

		ctx.ui.setStatus(
			"caveman",
			theme.fg("muted", "caveman: ") + theme.fg("text", level.toUpperCase()),
		);
	};

	// -- Restore state on session load --

	pi.on("session_start", async (_event, ctx) => {
		await configStore.ensureConfigLoaded();

		const result = resolveSessionLevel(configStore.getConfig(), ctx.sessionManager.getEntries());
		configStore.setLevel(result.level);
		if (shouldAppendCavemanEntry(result.shouldAppendEntry, ctx.isProjectTrusted())) {
			pi.appendEntry("caveman-level", { level: result.level });
		}

		syncStatus(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		syncStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		syncStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		configStore.setLevel(resetSessionLevel(configStore.getLevel()));
	});

	// -- /caveman command --

	registerCavemanCommand(pi, configStore, syncStatus);

	// -- Inject caveman rules into system prompt --

	pi.on("before_agent_start", async (event, ctx) => {
		await configStore.ensureConfigLoaded();
		const level = configStore.getLevel();

		// Resolve compression based on mode (skip in JSON/RPC to avoid mangling structured output)
		const compression = resolveCompression(level, ctx.mode);
		if (compression.skip) return;

		// If structured search tools are active, lighten compression to preserve tool output
		let intensity = compression.intensity;
		if (shouldLightenCompression(event.systemPromptOptions) && intensity !== "lite") {
			intensity = "lite";
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${CAVEMAN_BASE}\n\n${INTENSITY[intensity]}`,
		};
	});
}
