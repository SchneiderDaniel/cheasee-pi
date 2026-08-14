/**
 * zzz-dump-context — Dumps the assembled system prompt to ignore/ on /dump-context command
 *
 * The zzz- prefix ensures this extension's before_agent_start handler runs LAST
 * (alphabetical order), so it captures the final system prompt after ALL other
 * extensions (caveman, ponytail, session-advice) have applied their modifications.
 *
 * The model receives ONE assembled system message (verified in pi's
 * dist/core/system-prompt.js): context files are inlined into <project_context>,
 * skills into <available_skills>. The options snapshot (dump-context-options.json)
 * MIRRORS that content — that mirroring is where perceived "duplicates" come
 * from, not the prompt itself.
 *
 * dump-context.txt is written sectioned, each part labeled with its source:
 *   [1] Base system prompt = pi built-in (no custom system.md configured)
 *   [2] System prompt append = APPEND_SYSTEM.md (global append, every repo)
 *   [3] Project context = AGENTS.md (inlined from contextFiles)
 *   [4] Skills (only model-invocation-enabled ones)
 *   [5] Trailing (cwd)
 *   [6] Extension injections (caveman, ponytail, session-advice)
 *
 * Usage: /dump-context  → writes ignore/dump-context.txt (sectioned + attributed)
 *                          + ignore/dump-context-options.json (raw snapshot)
 *                          + prints section sizes + duplicate report
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
	toolSnippets?: Record<string, string>;
	appendSystemPrompt?: string;
	cwd?: string;
}

let lastSystemPrompt = "";
let lastOptions: PromptOptions | null = null;

/** Rough token estimate: chars / 4 (conservative for English text). */
function estimateTokens(text: string): number {
	return Math.round(text.length / 4);
}

interface Section {
	label: string;
	source: string;
	body: string;
}

/** Headers that extension injections start with (earliest match splits base vs injections). */
const INJECTION_MARKERS = ["## Caveman Mode", "PONYTAIL MODE ACTIVE", "## Past Session Lessons"];

/** Anchors marking the start of the global append (APPEND_SYSTEM.md) text.
 *  pi concatenates the append as bare text immediately after the base prompt,
 *  before <project_context>; the first line of APPEND_SYSTEM.md is an H1 that
 *  acts as the split seam, with <system_role> as fallback. */
const APPEND_ANCHORS = ["# Global Cheasee-Pi Operating Instructions", "<system_role>"];

/** Split the assembled prompt into attributed sections.
 *  Order follows pi's buildSystemPrompt: base → append (APPEND_SYSTEM.md) →
 *  <project_context> → skills → cwd, with extension injections appended at
 *  the END via before_agent_start (caveman/ponytail modify systemPrompt after
 *  the initial build). */
export function splitSections(prompt: string): Section[] {
	// Grab structural XML blocks first
	const grab = (open: string, close: string) => {
		const start = prompt.indexOf(open);
		const end = start >= 0 ? prompt.indexOf(close, start) : -1;
		return end >= 0
			? { start, end: end + close.length, body: prompt.slice(start, end + close.length) }
			: null;
	};
	const ctx = grab("<project_context>", "</project_context>");
	const skills = grab("<available_skills>", "</available_skills>");

	// Remove structural blocks → rest = base + append + cwd + injections
	const ranges = [ctx, skills]
		.filter((r): r is NonNullable<typeof r> => r !== null)
		.sort((a, b) => b.start - a.start);
	let rest = prompt;
	for (const r of ranges) rest = rest.slice(0, r.start) + "\n" + rest.slice(r.end);

	// Pull out cwd line
	const cwdMatch = rest.match(/Current working directory: \S+/);
	if (cwdMatch && cwdMatch.index !== undefined) {
		rest = rest.slice(0, cwdMatch.index) + "\n" + rest.slice(cwdMatch.index + cwdMatch[0].length);
	}

	// Base ends where the first injection marker starts
	let injIdx = -1;
	for (const m of INJECTION_MARKERS) {
		const i = rest.indexOf(m);
		if (i >= 0 && (injIdx < 0 || i < injIdx)) injIdx = i;
	}
	const tailEnd = injIdx > 0 ? injIdx : rest.length;

	// The append starts at the first anchor found before the injections
	let appendIdx = -1;
	for (const a of APPEND_ANCHORS) {
		const i = rest.indexOf(a);
		if (i >= 0 && i < tailEnd && (appendIdx < 0 || i < appendIdx)) appendIdx = i;
	}

	const baseBody = (appendIdx > 0 ? rest.slice(0, appendIdx) : rest.slice(0, tailEnd)).trim();
	const appendBody =
		appendIdx >= 0 ? rest.slice(appendIdx, tailEnd).trim() : "";
	const injBody = injIdx > 0 ? rest.slice(injIdx).trim() : "";

	const sections: Section[] = [];
	if (baseBody) {
		sections.push({
			label: "Base system prompt",
			source: "pi built-in (dist/core/system-prompt.js) — no custom system.md",
			body: baseBody,
		});
	}
	if (appendBody) {
		sections.push({
			label: "System prompt append (APPEND_SYSTEM.md)",
			source: "~/.pi/agent/APPEND_SYSTEM.md (global pi append, every repo)",
			body: appendBody,
		});
	}
	if (ctx) {
		sections.push({
			label: "Project context",
			source: "contextFiles (AGENTS.md)",
			body: ctx.body.trim(),
		});
	}
	if (skills) {
		sections.push({
			label: "Skills",
			source: "skills (model-invocation-enabled only)",
			body: skills.body.trim(),
		});
	}
	if (cwdMatch) sections.push({ label: "Working directory", source: "cwd", body: cwdMatch[0] });
	if (injBody) {
		sections.push({
			label: "Extension injections",
			source: "appended via before_agent_start (caveman, ponytail, session-advice)",
			body: injBody,
		});
	}
	return sections.filter((s) => s.body.length > 0);
}

/** Exact-duplicate 80-char blocks inside the prompt, ignoring path-like noise
 *  (pi install paths and .pi/skills prefixes repeat in skill <location> entries — benign). */
export function findPromptDupes(text: string): string[] {
	const seen = new Set<string>();
	const dups: string[] = [];
	for (let i = 0; i + 80 <= text.length; i++) {
		const block = text.slice(i, i + 80);
		if (block.includes("/node_modules/") || block.includes("/.pi/skills/")) continue;
		if (seen.has(block)) {
			if (!dups.includes(block)) dups.push(block);
		} else {
			seen.add(block);
		}
	}
	return dups;
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
		description: "Write the last system prompt to ignore/dump-context.txt (sectioned) with stats",
		handler: async (_args: string | undefined, ctx: ExtensionCommandContext) => {
			if (!lastSystemPrompt) {
				ctx.ui.notify("No prompt captured. Send a message first.", "warning");
				return;
			}

			const outDir = join(process.cwd(), "ignore");
			mkdirSync(outDir, { recursive: true });

			// ── Sectioned, attributed dump ───────────────────────────
			const sections = splitSections(lastSystemPrompt);
			const parts: string[] = [
				`# Context dump — ${new Date().toISOString()}`,
				"# The model receives ONE assembled system message. Sections below label the source of each part.",
				"",
			];
			sections.forEach((s, i) => {
				parts.push(
					`## [${i + 1}] ${s.label} — ${s.source}`,
					`##     ${s.body.length.toLocaleString()} B · ~${estimateTokens(s.body).toLocaleString()} tok`,
					"",
					s.body,
					"",
				);
			});
			const txtPath = join(outDir, "dump-context.txt");
			writeFileSync(txtPath, parts.join("\n"), "utf-8");

			const jsonPath = join(outDir, "dump-context-options.json");
			writeFileSync(jsonPath, JSON.stringify(lastOptions, null, 2), "utf-8");

			// ── Duplicate report ─────────────────────────────────────
			const inPromptDupes = findPromptDupes(lastSystemPrompt);
			const loadedSkills = lastOptions?.skills?.length ?? 0;
			const inPromptSkills = (lastSystemPrompt.match(/<skill>/g) || []).length;

			// ── Stats ────────────────────────────────────────────────
			const usage = ctx.getContextUsage();
			const actualTokens = usage?.tokens ?? null;
			const pct = usage?.percent !== null && usage?.percent !== undefined ? usage.percent : null;

			const lines: string[] = [];

			// Row 1: sizes
			const sizeParts = [`System prompt: ${lastSystemPrompt.length.toLocaleString()} B`];
			if (actualTokens !== null) sizeParts.push(`context: ${actualTokens.toLocaleString()} tok`);
			if (pct !== null) sizeParts.push(`${pct}%`);
			lines.push(sizeParts.join("  ·  "));

			// Row 2: section breakdown
			lines.push(
				`Sections: ${sections.length} — ${sections.map((s) => s.label.split(" ")[0]).join(" / ")}`,
			);

			// Row 3: skills
			lines.push(
				`Skills: ${inPromptSkills}/${loadedSkills} in prompt (${loadedSkills - inPromptSkills} disabled via disable-model-invocation)`,
			);

			// Row 4: duplicates
			lines.push(
				inPromptDupes.length === 0
					? "No duplicates inside prompt (path repeats excluded)"
					: `⚠ ${inPromptDupes.length} duplicate blocks inside prompt`,
			);
			lines.push(
				"JSON mirrors prompt: AGENTS.md, tools, guidelines, skills — same bytes in 2 files, model sees once",
			);

			lines.push(`→ ignore/dump-context.txt (sectioned)`);
			lines.push(`→ ignore/dump-context-options.json (raw)`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
