/**
 * Golden characterization tests for session-logger/renderer.ts.
 *
 * Captures byte-for-byte .md render output AND parseSessionStats JSON
 * snapshots (the metadata.json consumer) for representative session
 * fixtures, so the 321-line renderSessionToMarkdown split can be proven
 * output-equivalent (Feathers characterization-test pattern).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-renderer-golden.test.mts
 * Regenerate goldens (only when the renderer intentionally changes):
 *   GOLDEN_UPDATE=1 node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-renderer-golden.test.mts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSessionToMarkdown, parseSessionStats } from "../renderer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, "fixtures", "session-logger-renderer-goldens");
const UPDATE = process.env.GOLDEN_UPDATE === "1";

// ─── Fixture builders ─────────────────────────────────────────────

function sessionHeader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "session",
		id: "test-session-001",
		timestamp: "2025-06-01T10:00:00Z",
		cwd: "/tmp/project",
		// Numeric, matching CURRENT_SESSION_VERSION — ParsedSessionStats.version
		// is declared `number` (session-stats.ts); string "1.0" was a latent
		// type violation and a misfire trigger for version-gated logic.
		version: 3,
		...overrides,
	};
}

function userMsg(text: string, timestamp = "2025-06-01T10:01:00Z"): Record<string, unknown> {
	return {
		type: "message",
		timestamp,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function assistantMsg(opts: {
	thinking?: string;
	text?: string;
	toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
	usage?: Record<string, unknown>;
	stopReason?: string;
	timestamp?: string;
}): Record<string, unknown> {
	const content: Array<Record<string, unknown>> = [];
	if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking });
	if (opts.text) content.push({ type: "text", text: opts.text });
	for (const tc of opts.toolCalls ?? []) {
		content.push({ type: "toolCall", name: tc.name, arguments: tc.args });
	}
	return {
		type: "message",
		timestamp: opts.timestamp ?? "2025-06-01T10:02:00Z",
		message: {
			role: "assistant",
			content,
			usage: opts.usage ?? {
				input: 100,
				output: 50,
				cacheRead: 10,
				cacheWrite: 5,
				totalTokens: 165,
				cost: { total: 0.001 },
			},
			stopReason: opts.stopReason ?? "end_turn",
		},
	};
}

function toolResultMsg(
	toolName: string,
	text: string,
	opts: { isError?: boolean; timestamp?: string } = {},
): Record<string, unknown> {
	return {
		type: "message",
		timestamp: opts.timestamp ?? "2025-06-01T10:03:00Z",
		message: {
			role: "toolResult",
			toolName,
			isError: opts.isError ?? false,
			content: [{ type: "text", text }],
		},
	};
}

function customSupervisor(
	details: Record<string, unknown>,
	opts: { data?: Record<string, unknown>; timestamp?: string } = {},
): Record<string, unknown> {
	return {
		type: "custom",
		customType: "supervisor",
		timestamp: opts.timestamp ?? "2025-06-01T10:04:00Z",
		data: opts.data ?? {},
		details,
	};
}

function toolComplete(
	toolName: string,
	agentName: string,
	opts: { isError?: boolean; toolDurationMs?: number } = {},
): Record<string, unknown> {
	return customSupervisor({
		eventType: "tool-complete",
		toolName,
		agentName,
		isError: opts.isError ?? false,
		toolDurationMs: opts.toolDurationMs ?? 1234,
	});
}

const FULL_TURN = [
	userMsg("First user question"),
	assistantMsg({
		thinking: "Let me think about this.",
		text: "I'll check the file.",
		toolCalls: [{ name: "read", args: { path: "src/main.py" } }],
	}),
	toolResultMsg("read", "def main():\n    pass"),
];

// ─── Corpus ────────────────────────────────────────────────────────

interface GoldenCase {
	name: string;
	entries: Record<string, unknown>[];
	overrides?: { sessionName?: string; mode?: string };
}

const CASES: GoldenCase[] = [
	// header-only
	{ name: "header-only", entries: [sessionHeader()] },

	// full multi-turn: user→assistant(thinking+text+toolCall)→toolResult, then a second exchange
	{
		name: "full-multi-turn",
		entries: [
			sessionHeader(),
			...FULL_TURN,
			userMsg("Follow up question"),
			assistantMsg({
				text: "Done.",
				usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } },
			}),
		],
	},

	// assistant-before-user
	{
		name: "assistant-before-user",
		entries: [sessionHeader(), assistantMsg({ text: "Preemptive note" }), userMsg("Hello")],
	},

	// consecutive user turns (--- separator)
	{
		name: "consecutive-users",
		entries: [sessionHeader(), userMsg("First"), userMsg("Second")],
	},

	// model_change + thinking_level_change + compaction pass-through entries
	{
		name: "model-change",
		entries: [
			sessionHeader(),
			{
				type: "model_change",
				timestamp: "2025-06-01T10:05:00Z",
				provider: "anthropic",
				modelId: "claude-sonnet-4",
			},
		],
	},
	{
		name: "thinking-change",
		entries: [
			sessionHeader(),
			{ type: "thinking_level_change", timestamp: "2025-06-01T10:05:00Z", thinkingLevel: "high" },
		],
	},
	{
		name: "compaction",
		entries: [
			sessionHeader(),
			{ type: "compaction", timestamp: "2025-06-01T10:05:00Z", tokensBefore: 75000 },
		],
	},

	// supervisor custom details variants
	{
		name: "custom-supervisor-full",
		entries: [
			sessionHeader(),
			customSupervisor({
				agentName: "dev-agent",
				statusLabel: "SUCCESS",
				toolCount: 3,
				tokenCount: 12000,
				durationMs: 84000,
				thinkingOutput: "First thinking line\nSecond thinking line",
				hasThinking: true,
				textOutput: "read(path=src/main.py)\nsrc/main.py -- 2KB",
				rawOutput: "raw dump\nline 2",
				hasRawOutput: true,
				auditScore: 4,
			}),
		],
	},
	{
		name: "custom-supervisor-failed",
		entries: [
			sessionHeader(),
			customSupervisor({
				agentName: "dev-agent",
				statusLabel: "FAILED",
				toolCount: 1,
				tokenCount: 300,
				durationMs: 59999,
				textOutput: "edit failed",
				auditScore: 1,
			}),
		],
	},
	{
		name: "custom-supervisor-minimal",
		entries: [sessionHeader(), customSupervisor({ agentName: "dev-agent" })],
	},
	{
		name: "custom-supervisor-no-details",
		entries: [sessionHeader(), customSupervisor({})],
	},

	// non-supervisor custom fallthrough — with and without data
	{
		name: "custom-non-supervisor-data",
		entries: [
			sessionHeader(),
			{
				type: "custom",
				customType: "other",
				timestamp: "2025-06-01T10:04:00Z",
				data: { foo: "bar" },
			},
		],
	},
	{
		name: "custom-non-supervisor-no-data",
		entries: [
			sessionHeader(),
			{ type: "custom", customType: "other", timestamp: "2025-06-01T10:04:00Z", data: {} },
		],
	},

	// subagent tool-complete: merged flat toolStats + per-agent breakdown, isError, multiple agents
	{
		name: "subagent-tool-complete",
		entries: [
			sessionHeader(),
			toolComplete("bash", "agent-a", { toolDurationMs: 500 }),
			toolComplete("bash", "agent-a", { isError: true, toolDurationMs: 1500 }),
			toolComplete("read", "agent-b", { toolDurationMs: 200 }),
		],
	},

	// overrides — sessionName / mode / both
	{
		name: "overrides-session-name",
		entries: [sessionHeader(), ...FULL_TURN],
		overrides: { sessionName: "My Session" },
	},
	{
		name: "overrides-mode",
		entries: [sessionHeader(), ...FULL_TURN],
		overrides: { mode: "full" },
	},
	{
		name: "overrides-both",
		entries: [sessionHeader(), ...FULL_TURN],
		overrides: { sessionName: "My Session", mode: "full" },
	},

	// escMd in tables: pipes + backticks in overrides, tool paths, tool names
	{
		name: "escaping-in-tables",
		entries: [
			sessionHeader(),
			assistantMsg({
				text: "Escaping check",
				toolCalls: [{ name: "read", args: { path: "src/weird|file`x.ts" } }],
			}),
			toolResultMsg("bash|pipe", "ok"),
			toolResultMsg("edit", "single line ok"),
		],
		overrides: { sessionName: "A|B`C", mode: "x|y`z" },
	},

	// file-access: consecutive same-action dedup + interleaved non-dedup
	{
		name: "file-access-dedup",
		entries: [
			sessionHeader(),
			assistantMsg({
				text: "Multiple edits",
				toolCalls: [
					{ name: "read", args: { path: "a.ts" } },
					{ name: "read", args: { path: "a.ts" } },
					{ name: "write", args: { path: "b.ts", content: "x" } },
					{ name: "read", args: { path: "a.ts" } },
				],
			}),
		],
	},

	// truncation boundaries: multi-line result >8 lines, single-line >200 chars, args >80 chars
	{
		name: "truncation-boundaries",
		entries: [
			sessionHeader(),
			assistantMsg({
				text: "Big outputs",
				toolCalls: [{ name: "bash", args: { command: "run-" + "a".repeat(100) } }],
			}),
			toolResultMsg("bash", Array.from({ length: 10 }, (_v, i) => `line ${i}`).join("\n")),
			toolResultMsg("read", "x".repeat(250)),
		],
	},

	// fmtTokens thresholds: 999 / 1000 / 999999 / 1000000
	{
		name: "fmt-token-thresholds",
		entries: [
			sessionHeader(),
			assistantMsg({
				text: "a",
				usage: { input: 500, output: 499, totalTokens: 999, cost: { total: 0 } },
			}),
			assistantMsg({
				text: "b",
				usage: { input: 500, output: 500, totalTokens: 1000, cost: { total: 0 } },
			}),
			assistantMsg({
				text: "c",
				usage: { input: 500000, output: 499999, totalTokens: 999999, cost: { total: 0 } },
			}),
			assistantMsg({
				text: "d",
				usage: { input: 500000, output: 500000, totalTokens: 1000000, cost: { total: 0 } },
			}),
		],
	},

	// fmtCost thresholds: 0 / 0.0009 / 0.001 / 0.9999 / 1 / 123.456
	{
		name: "fmt-cost-thresholds",
		entries: [
			sessionHeader(),
			assistantMsg({
				text: "a",
				usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
			}),
			assistantMsg({
				text: "b",
				usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.0009 } },
			}),
			assistantMsg({
				text: "c",
				usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } },
			}),
			assistantMsg({
				text: "d",
				usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.9999 } },
			}),
			assistantMsg({
				text: "e",
				usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 1 } },
			}),
			assistantMsg({
				text: "f",
				usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 123.456 } },
			}),
		],
	},

	// fmtDuration thresholds via supervisor details: 999 / 1000 / 59999 / 60000 / 90000
	{
		name: "fmt-duration-thresholds",
		entries: [
			sessionHeader(),
			customSupervisor({ agentName: "d1", durationMs: 999 }),
			customSupervisor({ agentName: "d2", durationMs: 1000 }),
			customSupervisor({ agentName: "d3", durationMs: 59999 }),
			customSupervisor({ agentName: "d4", durationMs: 60000 }),
			customSupervisor({ agentName: "d5", durationMs: 90000 }),
		],
	},

	// thinking preview > 120 chars → collapsed with char count
	{
		name: "thinking-preview-long",
		entries: [sessionHeader(), assistantMsg({ thinking: "x".repeat(150), text: "Long thought" })],
	},
];

// ─── Golden helpers ────────────────────────────────────────────────

function goldenPath(name: string, ext: string): string {
	return join(GOLDEN_DIR, `${name}.${ext}`);
}

describe("session-logger renderer golden characterization (byte-for-byte)", () => {
	for (const c of CASES) {
		it(`renders ${c.name} (md + stats)`, () => {
			const tmpDir = mkdtempSync(path.join(os.tmpdir(), "session-logger-golden-"));
			try {
				const filepath = path.join(tmpDir, "test-session.jsonl");
				const lines = c.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
				writeFileSync(filepath, lines, "utf-8");

				const md = renderSessionToMarkdown(filepath, c.overrides);
				const stats = parseSessionStats(filepath);

				const mdFile = goldenPath(c.name, "md");
				const statsFile = goldenPath(c.name, "stats.json");
				if (UPDATE) {
					mkdirSync(GOLDEN_DIR, { recursive: true });
					writeFileSync(mdFile, md + "\n", "utf8");
					writeFileSync(statsFile, JSON.stringify(stats, null, 2) + "\n", "utf8");
					return;
				}
				assert.ok(
					existsSync(mdFile),
					`missing golden ${mdFile} — run with GOLDEN_UPDATE=1 to create`,
				);
				assert.equal(md + "\n", readFileSync(mdFile, "utf8"), `md golden mismatch for ${c.name}`);
				assert.ok(
					existsSync(statsFile),
					`missing golden ${statsFile} — run with GOLDEN_UPDATE=1 to create`,
				);
				assert.equal(
					JSON.stringify(stats, null, 2) + "\n",
					readFileSync(statsFile, "utf8"),
					`stats golden mismatch for ${c.name}`,
				);
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	}
});

// ─── Version handling (fixture version is numeric) ─────────────────

function writeJsonlTo(dir: string, entries: Record<string, unknown>[]): string {
	const filepath = path.join(dir, "test-session.jsonl");
	const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
	writeFileSync(filepath, lines, "utf-8");
	return filepath;
}

describe("session-logger renderer version handling", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "session-logger-golden-ver-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("header-only fixture → stats.version is numeric 3", () => {
		const filepath = writeJsonlTo(tmpDir, [sessionHeader()]);
		const stats = parseSessionStats(filepath);
		assert.ok(stats, "expected stats");
		assert.equal(stats.version, 3);
		assert.equal(typeof stats.version, "number");
	});

	it("header missing version → stats.version === 0", () => {
		const filepath = writeJsonlTo(tmpDir, [
			{ type: "session", id: "no-ver", timestamp: "2025-06-01T10:00:00Z", cwd: "/tmp" },
		]);
		const stats = parseSessionStats(filepath);
		assert.ok(stats, "expected stats");
		assert.equal(stats.version, 0);
	});

	it("no stale string-version fixtures remain in golden corpus", () => {
		const files = readdirSync(GOLDEN_DIR).filter(
			(f) => f.endsWith(".md") || f.endsWith(".stats.json"),
		);
		assert.ok(files.length > 0, "expected golden fixtures present");
		for (const f of files) {
			const content = readFileSync(join(GOLDEN_DIR, f), "utf8");
			assert.ok(
				!content.includes('"version": "1.0"') && !content.includes("| **Version** | 1.0 |"),
				`stale string version in ${f}`,
			);
		}
	});
});

// ─── Boundary error paths ──────────────────────────────────────────

describe("session-logger renderer boundary error paths", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(path.join(os.tmpdir(), "session-logger-golden-edge-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(entries: Record<string, unknown>[]): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
		writeFileSync(filepath, lines, "utf-8");
		return filepath;
	}

	it("missing file → ENOENT propagates from renderSessionToMarkdown", () => {
		assert.throws(() => renderSessionToMarkdown(path.join(tmpDir, "missing.jsonl")), {
			code: "ENOENT",
		});
	});

	it("missing file → ENOENT propagates from parseSessionStats", () => {
		assert.throws(() => parseSessionStats(path.join(tmpDir, "missing.jsonl")), {
			code: "ENOENT",
		});
	});

	it("malformed JSON line → SyntaxError propagates from renderSessionToMarkdown", () => {
		const filepath = path.join(tmpDir, "bad.jsonl");
		fs.writeFileSync(filepath, '{"type":"session"}\n{not json\n', "utf-8");
		assert.throws(() => renderSessionToMarkdown(filepath), SyntaxError);
	});

	it("malformed JSON line → SyntaxError propagates from parseSessionStats", () => {
		const filepath = path.join(tmpDir, "bad.jsonl");
		fs.writeFileSync(filepath, '{"type":"session"}\n{not json\n', "utf-8");
		assert.throws(() => parseSessionStats(filepath), SyntaxError);
	});

	it("empty file → renderSessionToMarkdown returns '*Empty session*'", () => {
		const filepath = path.join(tmpDir, "empty.jsonl");
		fs.writeFileSync(filepath, "", "utf-8");
		assert.equal(renderSessionToMarkdown(filepath), "*Empty session*");
	});

	it("whitespace-only file → renderSessionToMarkdown returns '*Empty session*'", () => {
		const filepath = path.join(tmpDir, "blank.jsonl");
		fs.writeFileSync(filepath, "  \n\n  ", "utf-8");
		assert.equal(renderSessionToMarkdown(filepath), "*Empty session*");
	});

	it("empty file → parseSessionStats returns null", () => {
		const filepath = path.join(tmpDir, "empty.jsonl");
		fs.writeFileSync(filepath, "", "utf-8");
		assert.equal(parseSessionStats(filepath), null);
	});

	it("unknown entry type is skipped silently", () => {
		const filepath = writeJsonl([sessionHeader(), { type: "mystery-entry", data: { x: 1 } }]);
		const out = renderSessionToMarkdown(filepath);
		assert.ok(!out.includes("mystery-entry"));
	});

	it("message with unknown role renders nothing, no crash", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{ type: "message", message: { role: "weird", content: [{ type: "text", text: "x" }] } },
		]);
		const out = renderSessionToMarkdown(filepath);
		assert.ok(!out.includes("weird"));
	});
});

// ─── Structural guard (split integrity) ────────────────────────────
// Precedent: supervisor/test/message-renderers.test.mts — every renderer/*
// module imports standalone (no TDZ/cycle) and nothing imports back into
// the public renderer.ts entry.

describe("renderer/* import standalone (no ESM cycle)", () => {
	const dir = join(__dirname, "..", "renderer");
	const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

	for (const f of files) {
		it(`${f} dynamically imports without TDZ errors`, async () => {
			await import(`../renderer/${f}`);
		});
	}

	it("no renderer/* imports back from renderer.ts", () => {
		for (const f of files) {
			const source = readFileSync(join(dir, f), "utf8");
			assert.ok(
				!source.includes('from "../renderer.ts"'),
				`${f} must not import back from renderer.ts (ESM cycle risk)`,
			);
		}
	});

	it("parse.ts does not import host parseSessionEntries/migrateSessionEntries", () => {
		// Reinvention #1403 settled: the fail-closed manual parse stays. Any
		// import of the host package's parse/migrate helpers would violate the
		// docstring contract in parse.ts.
		const source = readFileSync(join(dir, "parse.ts"), "utf8");
		assert.ok(
			!source.includes('from "@earendil-works/pi-coding-agent"'),
			"parse.ts must not import host parse/migrate helpers (reinvention #1403)",
		);
	});
});
