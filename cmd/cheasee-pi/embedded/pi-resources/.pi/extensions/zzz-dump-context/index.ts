/**
 * zzz-dump-context — Dumps the assembled system prompt to ignore/ on /dump-context command
 *
 * The zzz- prefix ensures this extension's before_agent_start handler runs LAST
 * (alphabetical order), so it captures the final system prompt after ALL other
 * extensions (caveman, ponytail, session-advice) have applied their modifications.
 *
 * Usage: /dump-context  → writes ignore/dump-context.txt + ignore/dump-context-options.json
 *                          prints context stats to terminal
 *        /reload        → pick up changes after editing this file
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Minimal shape of BuildSystemPromptOptions (not re-exported from package top-level)
interface PromptOptions {
	selectedTools?: string[];
	promptGuidelines?: string[];
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Array<{ name: string; description: string }>;
	appendSystemPrompt?: string;
	cwd?: string;
}

let lastSystemPrompt = "";
let lastOptions: PromptOptions | null = null;

/** Rough token estimate: chars / 4 (conservative for English text). */
function estimateTokens(text: string): number {
	return Math.round(text.length / 4);
}

/** Count top-level sections in system prompt (## or ### headings). */
function countSections(text: string): number {
	return (text.match(/^#{2,3}\s/gm) || []).length;
}

/** Count XML skill blocks. */
function countSkillBlocks(text: string): number {
	return (text.match(/<skill>/g) || []).length;
}

export default function dumpContextExtension(pi: ExtensionAPI): void {
	// Capture final prompt each turn (runs after all other before_agent_start handlers)
	pi.on("before_agent_start", async (event) => {
		lastSystemPrompt = event.systemPrompt;
		lastOptions = event.systemPromptOptions as PromptOptions | null;
		return undefined;
	});

	// Write + print stats on /dump-context command
	pi.registerCommand("dump-context", {
		description: "Write the last system prompt to ignore/dump-context.txt with stats",
		handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
			if (!lastSystemPrompt) {
				ctx.ui.notify("No prompt captured. Send a message first.", "warning");
				return;
			}

			const outDir = join(process.cwd(), "ignore");
			mkdirSync(outDir, { recursive: true });

			const txtPath = join(outDir, "dump-context.txt");
			writeFileSync(txtPath, lastSystemPrompt, "utf-8");

			const jsonPath = join(outDir, "dump-context-options.json");
			writeFileSync(jsonPath, JSON.stringify(lastOptions, null, 2), "utf-8");

			// ── Stats ────────────────────────────────────────────────
			const bytes = lastSystemPrompt.length;
			const estTokens = estimateTokens(lastSystemPrompt);
			const sections = countSections(lastSystemPrompt);
			const skillCount = countSkillBlocks(lastSystemPrompt);

			const tools = lastOptions?.selectedTools ?? [];
			const builtIn = new Set(["read", "bash", "edit", "write"]);
			const extTools = tools.filter((t) => !builtIn.has(t));
			const guidelines = lastOptions?.promptGuidelines?.length ?? 0;
			const contextFiles = lastOptions?.contextFiles?.length ?? 0;

			// Actual context usage from the model (system + conversation history)
			const usage = ctx.getContextUsage();
			const actualTokens = usage?.tokens ?? null;
			const pct = usage?.percent !== null && usage?.percent !== undefined ? usage.percent : null;

			// Detect active injections from prompt text
			const hasCaveman = lastSystemPrompt.includes("## Caveman Mode");
			const hasPonytail = lastSystemPrompt.includes("PONYTAIL MODE ACTIVE");
			const hasLessons = lastSystemPrompt.includes("Past Session Lessons");

			const lines: string[] = [];

			// Row 1: sizes
			const sizeParts = [`System prompt: ${bytes.toLocaleString()} B`];
			if (actualTokens !== null) sizeParts.push(`context: ${actualTokens.toLocaleString()} tok`);
			if (pct !== null) sizeParts.push(`${pct}%`);

			// Row 2: tokens estimate vs actual
			const tokParts = [`~${estTokens.toLocaleString()} tok (est)`];
			if (actualTokens !== null) {
				const diff = actualTokens - estTokens;
				const sign = diff >= 0 ? "+" : "";
				tokParts.push(`API: ${actualTokens.toLocaleString()} tok (${sign}${diff})`);
			}
			lines.push(sizeParts.join("  ·  "));
			lines.push(tokParts.join("  ·  "));

			// Row 3: resources
			lines.push(
				`${tools.length} tools (${extTools.length} ext)  ·  ${skillCount} skills  ·  ${contextFiles} ctx files  ·  ${guidelines} guidelines  ·  ${sections} sections`,
			);

			// Row 4: injections
			const modes: string[] = [];
			if (hasCaveman) modes.push("caveman");
			if (hasPonytail) modes.push("ponytail");
			if (hasLessons) modes.push("lessons");
			if (modes.length > 0) lines.push(`Injections: ${modes.join(", ")}`);
			else if (actualTokens === null) lines.push("Context window usage unavailable");

			lines.push(`→ ignore/dump-context.txt`);
			lines.push(`→ ignore/dump-context-options.json`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
