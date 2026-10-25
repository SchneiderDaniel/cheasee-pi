import assert from "node:assert";

import fs from "node:fs";

import path from "node:path";

import os from "node:os";

import { describe, it, beforeEach, afterEach } from "node:test";

import {
	appendQnaEntry,
	readQnaEntries,
	getQnaEntry,
	listQnaEntries,
	queryQnaEntries,
} from "../jsonl-logger.ts";

import askUser from "../index.ts";

interface MockPi {
	registerTool: (tool: any) => void;
	on: (event: string, handler: any) => void;
	registerCommand: (name: string, cmd: any) => void;
	sendUserMessage: (msg: string, opts?: any) => void;
}

interface SessionHandlerHolder {
	handler: ((event: string, ctx: any) => Promise<void>) | null;
}

function makeMockPi(): {
	mockPi: MockPi;
	tools: Record<string, any>;
	commands: Record<string, any>;
	sessionHandlerHolder: SessionHandlerHolder;
	messages: Array<{ msg: string; opts?: any }>;
} {
	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const messages: Array<{ msg: string; opts?: any }> = [];
	const sessionHandlerHolder: SessionHandlerHolder = { handler: null };

	const mockPi: MockPi = {
		registerTool: (tool: any) => {
			tools[tool.name] = tool;
		},
		on: (event: string, handler: any) => {
			if (event === "session_start") {
				sessionHandlerHolder.handler = handler;
			}
		},
		registerCommand: (name: string, cmd: any) => {
			commands[name] = cmd;
		},
		sendUserMessage: (msg: string, opts?: any) => {
			messages.push({ msg, opts });
		},
	};

	return { mockPi, tools, commands, sessionHandlerHolder, messages };
}

describe("list/get absolute ids (issue #1614)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-abs-adapter-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Append N entries; optional marker prefix for specific positions. */
	async function appendN(n: number, marker?: (i: number) => string): Promise<void> {
		for (let i = 1; i <= n; i++) {
			const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
			await appendQnaEntry(tmpDir, ts, `${marker ? marker(i) : ""}Entry ${i}`, `Answer ${i}`);
		}
	}

	async function makeFixture(): Promise<{
		commands: Record<string, any>;
		messages: Array<{ msg: string; opts?: any }>;
		tools: Record<string, any>;
		ctx: any;
	}> {
		const { mockPi, commands, messages, tools } = makeMockPi();
		askUser(mockPi as any);
		const ctx = {
			sessionManager: { getCwd: () => tmpDir },
			isProjectTrusted: async () => true,
		};
		return { commands, messages, tools, ctx };
	}

	it("/qna list with 30 entries renders absolute ids + total footer", async () => {
		await appendN(30);
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("list", ctx);

		const msg = messages[0]!.msg;
		assert.ok(
			msg.includes("| 11 | 2026-01-01T00:00:11.000Z | Entry 11 | Answer 11 |"),
			"row 1 should be labeled with absolute id 11",
		);
		assert.ok(
			msg.includes("| 30 | 2026-01-01T00:00:30.000Z | Entry 30 | Answer 30 |"),
			"last row should be labeled with absolute id 30",
		);
		assert.ok(msg.includes("Showing #11–#30 of 30"), "footer must show sliced range and total");
	});

	it("/qna list with fewer entries than limit → ids 1..N and full footer", async () => {
		await appendN(3);
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("list", ctx);

		const msg = messages[0]!.msg;
		assert.ok(msg.includes("| 1 | 2026-01-01T00:00:01.000Z | Entry 1 | Answer 1 |"));
		assert.ok(msg.includes("| 3 | 2026-01-01T00:00:03.000Z | Entry 3 | Answer 3 |"));
		assert.ok(msg.includes("Showing #1–#3 of 3"), "footer always rendered when list succeeds");
	});

	it("/qna list empty log → no history message, no table, no footer", async () => {
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("list", ctx);

		assert.strictEqual(messages[0]!.msg, "No Q&A history yet.");
		assert.ok(!messages[0]!.msg.includes("Showing #"), "no footer for empty log");
	});

	it("/qna search rows carry absolute match ids and roundtrip through get", async () => {
		await appendN(26, (i) => (i === 5 || i === 20 ? "needle " : ""));
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("search needle", ctx);

		const msg = messages[0]!.msg;
		assert.ok(msg.includes("| 5 | 2026-01-01T00:00:05.000Z | needle Entry 5 | Answer 5 |"));
		assert.ok(msg.includes("| 20 | 2026-01-01T00:00:20.000Z | needle Entry 20 | Answer 20 |"));

		// Displayed id roundtrips through get (shared root cause with list)
		messages.length = 0;
		await commands["qna"].handler("get 5", ctx);
		assert.ok(messages[0]!.msg.includes("needle Entry 5"), "get returns the search-row question");
		assert.ok(messages[0]!.msg.includes("Answer 5"), "get returns the search-row answer");
	});

	it("regression: --limit parse (custom honored, invalid falls back to 20)", async () => {
		await appendN(30);
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("list --limit 5", ctx);
		assert.ok(
			messages[0]!.msg.includes("Showing #26–#30 of 30"),
			"custom limit 5 should show last 5 entries",
		);

		messages.length = 0;
		await commands["qna"].handler("list --limit abc", ctx);
		assert.ok(
			messages[0]!.msg.includes("Showing #11–#30 of 30"),
			"invalid limit falls back to default 20",
		);
	});

	it("ask_user_read list payload: per-entry ids, count and total (truncated)", async () => {
		await appendN(25);
		const { tools, ctx } = await makeFixture();

		const result: any = await tools["ask_user_read"].execute(
			"call1",
			{ action: "list", limit: 20 },
			null,
			null,
			ctx,
		);

		const parsed = result.structuredContent;
		assert.strictEqual(parsed.count, 20);
		assert.strictEqual(parsed.total, 25, "payload carries full history size");
		assert.deepStrictEqual(
			parsed.entries.map((e: any) => e.id),
			Array.from({ length: 20 }, (_, i) => i + 6),
			"ids are absolute (6..25 for last 20 of 25)",
		);
		for (const e of parsed.entries) {
			assert.ok(typeof e.id === "number" && e.datetime && e.question && e.answer);
		}
		assert.strictEqual(result.details.total, 25);
	});

	it("ask_user_read fractional limit → integer ids, list-then-get roundtrip", async () => {
		await appendN(30);
		const { tools, ctx } = await makeFixture();

		// QnaReadParams.limit is Type.Number, so a fractional value reaches
		// listQnaEntries; it must be truncated to an integer so payload ids
		// are integral and resolve through get.
		const listResult: any = await tools["ask_user_read"].execute(
			"call1",
			{ action: "list", limit: 1.5 },
			null,
			null,
			ctx,
		);
		const listed = listResult.structuredContent;
		assert.strictEqual(listed.count, 1, "trunc(1.5) = 1 entry");
		assert.ok(Number.isInteger(listed.entries[0]!.id), "payload id must be an integer");
		assert.strictEqual(listed.entries[0]!.id, 30);

		const getResult: any = await tools["ask_user_read"].execute(
			"call2",
			{ action: "get", id: listed.entries[0]!.id },
			null,
			null,
			ctx,
		);
		const got = getResult.structuredContent;
		assert.strictEqual(got.entries[0]!.question, "Entry 30");
		assert.strictEqual(got.entries[0]!.answer, "Answer 30");
	});

	it("ask_user_read query payload: matched entries carry absolute ids", async () => {
		await appendN(26, (i) => (i === 5 || i === 20 ? "needle " : ""));
		const { tools, ctx } = await makeFixture();

		const result: any = await tools["ask_user_read"].execute(
			"call1",
			{ action: "query", text: "needle" },
			null,
			null,
			ctx,
		);

		const parsed = result.structuredContent;
		assert.strictEqual(parsed.count, 2, "count == number of matches");
		assert.deepStrictEqual(
			parsed.entries.map((e: any) => e.id),
			[5, 20],
			"query results keep absolute ids",
		);
	});

	it("ask_user_read get payload unchanged; list-then-get roundtrip with payload ids", async () => {
		await appendN(30);
		const { tools, ctx } = await makeFixture();

		const listResult: any = await tools["ask_user_read"].execute(
			"call1",
			{ action: "list", limit: 5 },
			null,
			null,
			ctx,
		);
		const listed = listResult.structuredContent;
		assert.strictEqual(listed.entries.length, 5);
		const firstId: number = listed.entries[0]!.id;
		assert.strictEqual(firstId, 26, "first of last 5 of 30");

		const getResult: any = await tools["ask_user_read"].execute(
			"call2",
			{ action: "get", id: firstId },
			null,
			null,
			ctx,
		);
		const got = getResult.structuredContent;
		assert.strictEqual(got.count, 1);
		assert.strictEqual(got.entries[0]!.datetime, "2026-01-01T00:00:26.000Z");
		assert.strictEqual(got.entries[0]!.question, "Entry 26");
		assert.strictEqual(got.entries[0]!.answer, "Answer 26");
		assert.ok(!("id" in got.entries[0]), "get payload entry shape has no id (unchanged)");
	});

	it("human journey: displayed row id → /qna get returns same question/answer", async () => {
		await appendN(30);
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("list", ctx);
		assert.ok(
			messages[0]!.msg.includes("| 11 | 2026-01-01T00:00:11.000Z | Entry 11 | Answer 11 |"),
		);

		messages.length = 0;
		await commands["qna"].handler("get 11", ctx);
		assert.ok(messages[0]!.msg.includes("Entry 11"), "get shows the row-11 question");
		assert.ok(messages[0]!.msg.includes("Answer 11"), "get shows the row-11 answer");
	});

	it("regression: get 0 → usage; get 999 → not found; context-dir-as-file → error surfaced", async () => {
		await appendN(5);
		const { commands, messages, ctx } = await makeFixture();

		await commands["qna"].handler("get 0", ctx);
		assert.ok(messages[0]!.msg.includes("positive number"), "id < 1 shows usage");

		messages.length = 0;
		await commands["qna"].handler("get 999", ctx);
		assert.strictEqual(messages[0]!.msg, "Entry #999 not found.");

		// .pi/context replaced by a regular file → list error surfaces
		messages.length = 0;
		const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-abs-file-"));
		try {
			await fs.promises.mkdir(path.join(fileDir, ".pi"), { recursive: true });
			await fs.promises.writeFile(path.join(fileDir, ".pi", "context"), "not a dir", "utf-8");
			const fileCtx = {
				sessionManager: { getCwd: () => fileDir },
				isProjectTrusted: async () => true,
			};
			await commands["qna"].handler("list", fileCtx);
			assert.ok(
				messages[0]!.msg.startsWith("Error reading Q&A history"),
				`list error surfaced, got: ${messages[0]!.msg}`,
			);
		} finally {
			fs.rmSync(fileDir, { recursive: true, force: true });
		}
	});
});
describe("ask_user_read registration guidance (issue #1614)", () => {
	it("description and guidelines require entries[].id usage and explain total", () => {
		const { mockPi, tools } = makeMockPi();
		askUser(mockPi as any);

		const tool = tools["ask_user_read"];
		assert.ok(tool, "ask_user_read tool must be registered");
		const guidance = [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n");

		assert.ok(
			guidance.includes("entries[].id"),
			"guidance must require consumers to use each returned entries[].id",
		);
		assert.ok(
			guidance.includes("total"),
			"guidance must explain the total field (full history size)",
		);
		assert.ok(
			/array position|counting rows|1\.\.N/.test(guidance),
			"guidance must warn against deriving ids from array positions",
		);
		assert.ok(
			!guidance.includes("1-based line number"),
			"guidance must not describe ids as generic 1-based line numbers",
		);
	});
});
describe("ask_user_read cancellation (Issue #1777)", () => {
	let tmpDir: string;
	let tools: Record<string, any>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-cancel-read-"));
		const { mockPi, tools: t } = makeMockPi();
		tools = t;
		askUser(mockPi as any);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("signal = null: list returns a success envelope without TypeError", async () => {
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");

		const result: any = await tools["ask_user_read"].execute(
			"call1",
			{ action: "list" },
			null,
			null,
			{ sessionManager: { getCwd: () => tmpDir }, isProjectTrusted: async () => true },
		);

		assert.strictEqual(result.structuredContent.count, 1);
		assert.ok(!result.isError);
	});

	it("trusted + pre-aborted signal: rejects AbortError, no success envelope", async () => {
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(
			tools["ask_user_read"].execute("call1", { action: "list" }, controller.signal, null, {
				sessionManager: { getCwd: () => tmpDir },
				isProjectTrusted: async () => true,
			}),
			{ name: "AbortError" },
		);
	});

	it("untrusted + pre-aborted signal: trust gate precedes abort (fail-closed)", async () => {
		const controller = new AbortController();
		controller.abort();

		const result: any = await tools["ask_user_read"].execute(
			"call1",
			{ action: "list" },
			controller.signal,
			null,
			{ sessionManager: { getCwd: () => tmpDir }, isProjectTrusted: async () => false },
		);

		assert.strictEqual(result.isError, true);
		assert.strictEqual(result.structuredContent.trustGranted, false);
		assert.ok(!("aborted" in result.structuredContent));
	});
});
describe("jsonl-logger cancellation (Issue #1777)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-cancel-jsonl-"));
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		await appendQnaEntry(tmpDir, "2026-05-15T20:00:00.000Z", "Q2", "A2");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function abortedSignal(): AbortSignal {
		const controller = new AbortController();
		controller.abort();
		return controller.signal;
	}

	it("readQnaEntries rejects AbortError on a pre-aborted signal", async () => {
		await assert.rejects(readQnaEntries(tmpDir, abortedSignal()), { name: "AbortError" });
	});

	it("listQnaEntries rejects AbortError on a pre-aborted signal", async () => {
		await assert.rejects(listQnaEntries(tmpDir, 20, abortedSignal()), {
			name: "AbortError",
		});
	});

	it("getQnaEntry rejects AbortError on a pre-aborted signal", async () => {
		await assert.rejects(getQnaEntry(tmpDir, 1, abortedSignal()), { name: "AbortError" });
	});

	it("queryQnaEntries rejects AbortError on a pre-aborted signal", async () => {
		await assert.rejects(queryQnaEntries(tmpDir, "Q1", abortedSignal()), {
			name: "AbortError",
		});
	});

	it("in-flight abort rejects AbortError, never resolves partial entries", async () => {
		const controller = new AbortController();
		const promise = readQnaEntries(tmpDir, controller.signal);
		controller.abort();
		await assert.rejects(promise, { name: "AbortError" });
	});

	it("non-aborted signal returns the same entries/count/total as signal-less", async () => {
		const controller = new AbortController();
		const without = await listQnaEntries(tmpDir, 20);
		const withSignal = await listQnaEntries(tmpDir, 20, controller.signal);
		assert.deepStrictEqual(withSignal, without);
		assert.strictEqual(withSignal.total, 2);
	});
});
