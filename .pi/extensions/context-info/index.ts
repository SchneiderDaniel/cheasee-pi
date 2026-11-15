/**
 * context-info — Rich status bar with git branch, model info, token usage, and TPS
 *
 * Replaces pi's default footer with an info-dense status line.
 * Shows: git branch, active model, thinking level, session timer,
 * token usage with thresholds, and tokens-per-second during streaming.
 * Works with any theme. Use /explain-extensions to list all active extensions.
 *
 * Composition root (issue #2033 split): the session bootstrap lives in
 * session-start.ts, the live event wiring in events.ts, the value probes in
 * lib/. This module owns the command surface and the session lifecycle; the
 * footer's issue data is written only by the events.ts bus listener.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { FooterState } from "./footer-state.ts";
import { listLocalExtensions } from "./extensions.ts";
import type { ExtensionMeta } from "./extensions.ts";
import { listLocalPrompts } from "./prompts.ts";
import type { PromptMeta } from "./prompts.ts";
import { listLocalSkills } from "./skills.ts";
import type { SkillMeta } from "./skills.ts";
import { createExplainCommand, formatWithWordWrap } from "./explain.ts";
import { registerFooterEvents } from "./events.ts";
import { startFooterSession } from "./session-start.ts";

const CASTLE_ART: string[] = [
	"                                                #@@@%+:",
	"                                              %@#===+#%@@@#:",
	"                                             %@+=========+*%@@#.",
	"                                            #@======------====#%@#:",
	"                                          :#@+==========-----====*%@%:",
	"                                        :#@#===+@@%*+=======--:-====*%@*.",
	"                                      -#@*=======+*#@@%*+=====--======+#@%-",
	"                                    =@@*=============+*%@%+-=======++**==*%%",
	"                                  =%%*==================+**====+#%@@#*=    #@",
	"                                +%%*=========================*@@+.         @=",
	"                              -*#=:---================+*#%%@@@=             @%",
	"                            =#*-:--:-=====-:::-==*#+%@+==.                  %@",
	"                         .#%+=::-:-==:*#%@#+%@%+.                           #@",
	"                       .@@#=:===%*%%*+#=:   Session:  \u{1F7E2} Logger  \u{1F7E2} Advice  #@",
	"                      #@#-:.+%-..                                           %@",
	"                      %%                                                    @@",
	"                      %%   \u{1F9F0} Extensions: 8  (/explain-extensions)         #@",
	"                      %%   \u{1F4DD} Prompts:    6  (/explain-prompts)            =@",
	"                      %%   \u{1F3A8} Themes:     3                               #@",
	"                      %%   \u{1F527} Skills:     4  (/explain-skills)             =@",
	"                      %@                                                 ## %@",
	"                      #@*==+**#%@@%#+:.@*%%+-.@*%%=@.@*%%+-. *%%+-==*%%+-. *%%",
	"                      #@*=%==*%%+-.=+**#%%=@.@*%%+-. *%%+-@@%#+:.@*%%+-.@* *%%",
];

export default function contextInfo(pi: ExtensionAPI): void {
	// FooterState — single source of truth for all mutable state
	// Initialized per session in session_start handler
	let state: FooterState | undefined;

	// ── Commands ────────────────────────────────────────────────────

	// explain-prompts: multi-line with wordWrap
	createExplainCommand<PromptMeta>(pi, "explain-prompts", "prompt", listLocalPrompts, {
		formatItem: formatWithWordWrap,
	});

	// explain-skills: multi-line with wordWrap
	createExplainCommand<SkillMeta>(pi, "explain-skills", "skill", listLocalSkills, {
		formatItem: formatWithWordWrap,
	});

	// explain-extensions: single-line with error handling
	createExplainCommand<ExtensionMeta>(pi, "explain-extensions", "extension", listLocalExtensions, {
		formatItem: (item, { accent, dim }) => {
			if (item.error) {
				return [accent("  " + item.name) + dim("  error: " + item.error)];
			}
			const firstLine = (item.description ?? "(no description)").split("\n")[0].trim();
			return [accent("  " + item.name) + dim("  " + firstLine)];
		},
	});

	// ── cheasee-pi-info command ────────────────────────────
	pi.registerCommand("cheasee-pi-info", {
		description: "Show castle ASCII art — static info display",
		handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
			const art = CASTLE_ART.join("\n");
			ctx.ui.notify(art, "info");
		},
	});

	// ── Live updates (footer state) ────────────────────────────────
	registerFooterEvents(pi, () => state);

	// ── Session lifecycle ──────────────────────────────────────────

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Dispose previous state to prevent stale ctx usage after
		// reload/newSession/fork/switchSession. The old state's timer closure
		// holds a captured ctx that becomes invalid on session replacement.
		if (state) {
			state.dispose();
		}
		state = (await startFooterSession(pi, ctx)) ?? undefined;
	});

	pi.on("session_shutdown", async () => {
		if (state) {
			state.dispose();
		}
	});
}
