/**
 * Characterization tests for renderer/details.ts content-block narrowing.
 *
 * Drives JSONL fixtures through the public renderSessionToMarkdown(filepath)
 * entry point (string arg → no upstream-type friction under tsc:extensions),
 * pinning the behaviour the `blocksOf` narrowing helper must preserve.
 *
 * Run with:
 *   node --experimental-strip-types --test \
 *     .pi/extensions/session-logger/test/session-logger-details-content-blocks.test.mts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSessionToMarkdown } from "../renderer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function sessionHeader(): Record<string, unknown> {
	return {
		type: "session",
		id: "test-content-blocks-001",
		timestamp: "2025-06-01T10:00:00Z",
		cwd: "/tmp",
		version: 3,
	};
}

describe("renderer/details.ts — content-block narrowing", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-content-blocks-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(entries: Record<string, unknown>[]): string {
		const filepath = path.join(tmpDir, "test-session.jsonl");
		const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.writeFileSync(filepath, lines, "utf-8");
		return filepath;
	}

	it("assistant: extracts only the requested discriminants (thinking/text/toolCall)", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "t" },
						{ type: "text", text: "hello" },
						{ type: "toolCall", name: "read", arguments: { path: "a" } },
						{ type: "mystery" },
					],
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("> 💭 t"), "thinking preview present");
		assert.ok(md.includes("hello"), "text block present");
		assert.ok(md.includes("- 🔧 `read(path=`a`)`"), "tool call rendered");
		assert.ok(!md.includes("mystery"), "unknown block is not rendered");
	});

	it("assistant: only unknown blocks → no crash, no stray content lines", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{ type: "message", message: { role: "assistant", content: [{ type: "mystery" }] } },
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("### Turn 1 — Assistant"), "assistant turn heading present");
		assert.ok(!md.includes("mystery"), "unknown block is not rendered");
	});

	it("user: preserves join order of text blocks", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("### Turn 1 — User"), "user turn heading present");
		assert.ok(md.includes("a\nb"), "text blocks joined in order");
	});

	it("user: empty content array → empty turn section, no crash", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{ type: "message", message: { role: "user", content: [] } },
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("### Turn 1 — User"), "user turn heading present");
	});

	it("user: missing content field → empty turn section, no crash (?? [] fallback)", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{ type: "message", message: { role: "user" } },
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("### Turn 1 — User"), "user turn heading present");
	});

	it("user: null content → empty turn section, no crash (?? [] fallback)", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{ type: "message", message: { role: "user", content: null } },
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("### Turn 1 — User"), "user turn heading present");
	});

	it("assistant: missing content field → heading only, no crash (?? [] fallback)", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{ type: "message", message: { role: "assistant" } },
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("### Turn 1 — Assistant"), "assistant turn heading present");
	});

	it("toolResult: missing content field → zero size, no crash (?? [] fallback)", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{ type: "message", message: { role: "toolResult", toolName: "read" } },
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("  📥 `read` — 0"), "result size derived from empty content");
	});

	it("message: unknown role with no content field → renders nothing, no crash", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{ type: "message", message: { role: "custom" } },
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(!md.includes("### Turn"), "no turn section for an unknown role");
	});

	it("toolResult: only text blocks drive size and preview", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: false,
					content: [{ type: "mystery" }, { type: "text", text: "result-ok" }],
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("  📥 `read` — 9"), "size derived from text content only");
		assert.ok(md.includes("`result-ok`"), "text preview present");
		assert.ok(!md.includes("mystery"), "unknown block is not rendered");
	});

	it("toolResult: isError → fenced, 300-char-truncated text", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "x".repeat(400) }],
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("  ```"), "error result is fenced");
		assert.ok(md.includes("…(+100 chars)"), "error result truncated to 300 chars");
	});

	it("boundary: assistant toolCall with non-object arguments renders raw string", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "bash", arguments: "raw-str" }],
				},
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(
			md.includes("- 🔧 `bash(raw-str)`"),
			"non-object arguments fall back to truncate(String)",
		);
	});

	it("boundary: malformed pass-through entries keep current undefined fallbacks", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{ type: "model_change" },
			{ type: "thinking_level_change" },
			{ type: "compaction" },
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("> **Model:** `undefined/undefined`"));
		assert.ok(md.includes("> **Thinking:** `undefined`"));
		assert.ok(md.includes("> **Context compacted** — 0 tokens summarized"));
	});

	it("boundary: string user content throws (report.ts owns the catch)", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{ type: "message", message: { role: "user", content: "a string" } },
		]);

		assert.throws(() => renderSessionToMarkdown(filepath));
	});

	it("supervisor custom entry: details render through the public entry point", () => {
		const filepath = writeJsonl([
			sessionHeader(),
			{
				type: "custom",
				customType: "supervisor",
				timestamp: "2025-06-01T10:04:00Z",
				data: {},
				details: { agentName: "auditor", statusLabel: "done", toolCount: 5, auditScore: 9 },
			},
		]);

		const md = renderSessionToMarkdown(filepath);
		assert.ok(md.includes("### Agent: auditor -- done"), "supervisor details header rendered");
		assert.ok(md.includes("5 tools"), "supervisor stats rendered");
		assert.ok(md.includes("Audit score: 9"), "supervisor audit score rendered");
	});
});

describe("renderer/details.ts — static guards", () => {
	const source = fs.readFileSync(join(__dirname, "..", "renderer", "details.ts"), "utf8");

	it("declares no any annotations", () => {
		assert.ok(
			!/(?::\s*any\b|\bas\s+any\b|<any>)/.test(source),
			"details.ts must not contain any annotations",
		);
	});

	it("collapses the text-extraction chain into blocksOf", () => {
		assert.ok(!source.includes('c.type === "text"'), "no inline text-block filter chains");
		assert.ok(source.includes("blocksOf"), "blocksOf helper owns extraction");
	});

	it("renderSupervisorDetails is module-private (unused export removed)", async () => {
		const mod = await import("../renderer/details.ts");
		assert.strictEqual(
			typeof (mod as Record<string, unknown>).renderSupervisorDetails,
			"undefined",
			"renderSupervisorDetails must not be exported — called only by renderCustomEntry",
		);
	});
});
