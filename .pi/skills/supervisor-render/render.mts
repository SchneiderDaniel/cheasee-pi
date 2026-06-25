// ─── Supervisor Render Harness ─────────────────────────────────────
// Renders supervisor messages with the REAL pi TUI (initTheme, live theme
// proxy, Box, Markdown, actual ANSI render lines) so output is the bytes
// pi would draw — never hypothetical.
//
// MODES
//   1. canonical fixtures (no session arg):
//        node --experimental-strip-types render.mts
//      Renders one example of every `eventType` discriminator case from
//      supervisor-events.ts. Use to sanity-check the renderer after edits.
//
//   2. replay a recorded session as-stored (replay-safety check):
//        node --experimental-strip-types render.mts <session.jsonl>
//      Feeds every supervisor custom_message through the current renderer
//      WITHOUT converting old format. Old-format messages (no eventType)
//      hit the default Markdown fallback and MUST reproduce their stored
//      `content` byte-for-byte. Catches regressions on old sessions.
//
//   3. render a recorded session converted to the new eventType format:
//        node --experimental-strip-types render.mts <session.jsonl> --convert
//      Maps OLD details shapes (toolCallResult / _subagentResult /
//      _progressUpdate) to the eventType discriminator and renders. Shows
//      what a NEW run of the same workflow looks like with the current
//      renderer — the view for discussing/iterating on rendering.
//
//   4. produce a side-by-side OLD vs NEW diff of a session:
//        node --experimental-strip-types render.mts <session.jsonl> --both
//      Writes <base>.old.txt and <base>.new.txt (ANSI stripped) and prints
//      line counts. Diff them to see what changed.
//
// OPTIONS (any order after the session path)
//   --strip        Strip ANSI escape codes from output (default: keep color)
//   --no-numbers   Drop trailing-space/width padding noise? (not impl; kept)
//   --max <N>      Render only the first N supervisor messages
//   --width <W>    Render width in columns (default 90)

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createMessageRenderer } from "../../extensions/supervisor/session/message-renderer.ts";

// ── theme: the proxy is not re-exported by the main package; locate the
// dist module by walking up from this file. ponytail: exports map blocks
// require.resolve, so walk import.meta.url.
const skillDir = new URL(".", import.meta.url);
let theme: {
	fg(c: string, t: string): string;
	bg(c: string, t: string): string;
	bold(t: string): string;
	italic(t: string): string;
};
let themeFound = false;
for (let d = skillDir; d.pathname !== "/"; d = new URL("..", d)) {
	const cand = new URL(
		"node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js",
		d,
	);
	try {
		const mod = await import(pathToFileURL(cand.pathname).href);
		theme = mod.theme;
		initTheme();
		themeFound = true;
		break;
	} catch {}
}
if (!themeFound)
	throw new Error("Could not locate @earendil-works/pi-coding-agent dist theme module");

// ── helpers ──
const renderer = createMessageRenderer({} as any);
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");
function render(m: any, opts: any, width: number, stripAnsi: boolean): string[] {
	const comp = renderer(m, opts, theme) as Component;
	const out = (comp as any).render(width) as string[];
	return stripAnsi ? out.map(strip) : out;
}

// ── session extraction ──
function loadSession(path: string): any[] {
	const msgs = readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const cm = msgs.filter(
		(m: any) =>
			m.type === "custom_message" &&
			typeof m.customType === "string" &&
			m.customType.startsWith("supervisor"),
	);
	return cm;
}

// ── OLD → eventType conversion (mirrors the old renderer branches) ──
// Recorded sessions pre-#1071 store supervisor progress as:
//   details._progressUpdate : true            → phase-change
//   details.toolCallResult  : { ... }          → tool-complete (name → toolName)
//   details._subagentResult : { content, ... } → subagent-result
//   (none)                                       → default (Markdown on content)
function convert(m: any): any {
	const d = m.details || {};
	if (d._progressUpdate) {
		const c = (m.content || "") as string;
		const am = c.match(/\*\*[⚙⏳]\s*([^*]+)\*\*\s*[—-]\s*(\S+)/);
		const agentName = am?.[1]?.trim() || "agent";
		const phase = (am?.[2] || "starting").toLowerCase();
		return {
			customType: "supervisor",
			content: c,
			details: { eventType: "phase-change", agentName, phase },
		};
	}
	if (d.toolCallResult) {
		const t = d.toolCallResult;
		return {
			customType: "supervisor",
			content: "",
			details: { ...t, eventType: "tool-complete", toolName: t.name },
		};
	}
	if (d._subagentResult) {
		return {
			customType: "supervisor",
			content: "",
			details: { eventType: "subagent-result", ...d._subagentResult },
		};
	}
	return { customType: "supervisor", content: m.content || "", details: {} };
}

// ── canonical fixtures (one per eventType) ──
const subagentDetails = {
	agentName: "architect",
	success: true,
	statusLabel: "SUCCESS",
	summaryLine: "Decided on approach",
	model: "anthropic/claude-sonnet-4",
	inputTokens: 1500,
	outputTokens: 4200,
	cacheRead: 1000,
	cacheWrite: 300,
	cost: 0.0234,
	turnCount: 3,
	durationMs: 45000,
	toolCalls: [
		{ name: "read", args: { path: "/x/y.ts" } },
		{ name: "bash", args: { command: "ls" } },
	],
	toolResults: [],
	taskPrompt: "Design the auth module",
	thinkingOutput: "We need to handle token expiry",
};
function canonical(): { label: string; message: any; options?: any }[] {
	const msg = (details: any, content = "") => ({ customType: "supervisor", content, details });
	return [
		{
			label: "phase-change",
			message: msg(
				{ eventType: "phase-change", agentName: "developer", phase: "starting" },
				"⏳ developer — starting phase",
			),
		},
		{
			label: "tool-complete (success)",
			message: msg({
				eventType: "tool-complete",
				agentName: "developer",
				toolName: "bash",
				args: "ls -la",
				isError: false,
				resultText: "file1.txt\nfile2.txt\n3 matches in src",
				thinking: "Running ls to list files",
				toolIndex: "#2",
				toolDurationMs: 1234,
				runningToolCount: 2,
				maxToolCalls: 10,
				runningTokenCount: 5969,
				agentTokenBudget: 300000,
				errorCount: 0,
				compacted: false,
			}),
		},
		{
			label: "tool-complete (error)",
			message: msg({
				eventType: "tool-complete",
				agentName: "developer",
				toolName: "grep",
				args: "pattern",
				isError: true,
				errorReason: "command not found",
				toolIndex: "#3",
			}),
		},
		{
			label: "thinking",
			message: msg(
				{
					eventType: "thinking",
					agentName: "developer",
					content: "Considering whether to use a cache here.",
				},
				"💭 developer",
			),
		},
		{
			label: "compaction",
			message: msg({ eventType: "compaction", agentName: "developer" }, "⚠ compacted"),
		},
		{
			label: "budget-exceeded",
			message: msg(
				{ eventType: "budget-exceeded", agentName: "developer", toolCount: 5, tokenCount: 50000 },
				"⚠ developer — budget exceeded",
			),
		},
		{
			label: "error",
			message: msg({
				eventType: "error",
				agentName: "developer",
				toolName: "bash",
				errorReason: "ENOENT no such file",
			}),
		},
		{
			label: "subagent-result (collapsed)",
			message: msg({
				eventType: "subagent-result",
				agentName: "architect",
				content: [{ type: "text", text: "## Auth design" }],
				details: subagentDetails,
			}),
			options: { expanded: false },
		},
		{
			label: "subagent-result (expanded)",
			message: msg({
				eventType: "subagent-result",
				agentName: "architect",
				content: [{ type: "text", text: "## Auth design\nUse JWT with refresh tokens." }],
				details: subagentDetails,
			}),
			options: { expanded: true },
		},
		{
			label: "default fallback (no eventType)",
			message: msg({ toolCallResult: { name: "bash", args: "ls" } }, ""),
		},
	];
}

// ── argv parsing ──
const argv = process.argv.slice(2);
const stripFlag = argv.includes("--strip");
const convertFlag = argv.includes("--convert");
const bothFlag = argv.includes("--both");
const sessionArg = argv.find((a) => !a.startsWith("--") && a !== String(argv[argv.indexOf(a) - 1]));
const maxIdx = argv.indexOf("--max");
const maxN = maxIdx >= 0 ? parseInt(argv[maxIdx + 1], 10) : Infinity;
const wIdx = argv.indexOf("--width");
const width = wIdx >= 0 ? parseInt(argv[wIdx + 1], 10) : 90;

function show(label: string, message: any, opts: any = {}) {
	console.log(`\n═══ ${label} ═══`);
	for (const l of render(message, opts, width, stripFlag)) console.log(l);
}

if (!sessionArg) {
	// Mode 1: canonical fixtures
	for (const it of canonical()) show(it.label, it.message, it.options ?? {});
	process.exit(0);
}

// ── session mode ──
const cm = loadSession(sessionArg).slice(0, maxN);
const stem = sessionArg
	.split("/")
	.pop()!
	.replace(/\.jsonl$/, "");
const base = `sup-${stem}`; // outputs written to cwd with a sup- prefix

if (bothFlag) {
	// Mode 4: write old.txt + new.txt (stripped) and print counts
	const oldLines: string[] = [],
		newLines: string[] = [];
	for (let i = 0; i < cm.length; i++) {
		const m = cm[i];
		oldLines.push(
			`── #${i} [${
				Object.keys(m.details || {})
					.sort()
					.join(",") || "none"
			}] ──`,
		);
		oldLines.push(...(m.content || "(no content)").split("\n"));
		newLines.push(`── #${i} ──`);
		try {
			newLines.push(...render(convert(m), { expanded: true }, width, true));
		} catch (e: any) {
			newLines.push("RENDER ERROR: " + e.message);
		}
	}
	writeFileSync(`${base}.old.txt`, oldLines.join("\n"));
	writeFileSync(`${base}.new.txt`, newLines.join("\n"));
	console.log(`session: ${sessionArg}`);
	console.log(`supervisor messages: ${cm.length}`);
	console.log(`old ${oldLines.length} lines -> ${base}.old.txt`);
	console.log(`new ${newLines.length} lines -> ${base}.new.txt`);
	console.log(`diff: diff ${base}.old.txt ${base}.new.txt`);
	process.exit(0);
}

// Mode 2 (replay as-stored) or Mode 3 (convert)
console.log(`# session: ${sessionArg}`);
console.log(
	`# mode: ${convertFlag ? "convert (new eventType)" : "replay (as-stored)"}   strip: ${stripFlag}   messages: ${cm.length}   width: ${width}`,
);
for (let i = 0; i < cm.length; i++) {
	const m = cm[i];
	const shape =
		Object.keys(m.details || {})
			.sort()
			.join(",") || "none";
	console.log(`\n── #${i} [${shape}] ──`);
	const msg = convertFlag
		? convert(m)
		: { customType: "supervisor", content: m.content, details: m.details };
	try {
		for (const l of render(msg, { expanded: true }, width, stripFlag)) console.log(l);
	} catch (e: any) {
		console.log("RENDER ERROR: " + e.message);
	}
}
