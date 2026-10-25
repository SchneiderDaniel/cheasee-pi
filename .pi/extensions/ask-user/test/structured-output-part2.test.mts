import assert from "node:assert";

import fs from "node:fs";

import os from "node:os";

import path from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it, beforeEach, afterEach } from "node:test";

import { Value } from "typebox/value";

import { QnaReadOutputSchema } from "../types.ts";

import { appendQnaEntry } from "../jsonl-logger.ts";

import askUser, { successResult } from "../index.ts";

const EXT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

interface MockUI {
	input: (
		title: string,
		placeholder?: string,
		opts?: { signal?: AbortSignal },
	) => Promise<string | undefined>;
	custom: (factory: unknown) => Promise<any>;
	select: (
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal },
	) => Promise<string | undefined>;
	notify: (message: string, type?: string) => void;
}

function makeMockCtx(mode: string, ui: Partial<MockUI>): any {
	return {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		sessionManager: { getCwd: () => "/test/project" },
		isProjectTrusted: async () => false,
		ui: {
			input: async () => undefined,
			custom: async () => undefined,
			select: async () => undefined,
			notify: () => {},
			...ui,
		},
	};
}

function registerTools(): Record<string, any> {
	const tools: Record<string, any> = {};
	const mockPi: any = {
		registerTool: (tool: any) => {
			tools[tool.name] = tool;
		},
		on: () => () => {},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		sendUserMessage: () => {},
	};
	askUser(mockPi);
	return tools;
}

function readCtx(projectDir: string, trusted = true): any {
	return {
		sessionManager: { getCwd: () => projectDir },
		isProjectTrusted: async () => trusted,
	};
}

function sortedKeys(obj: object): string[] {
	return Object.keys(obj).sort();
}

async function seed(dir: string, rows: Array<[string, string, string]>): Promise<void> {
	for (const [dt, q, a] of rows) await appendQnaEntry(dir, dt, q, a);
}

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function walkFiles(dir: string, out: string[] = []): string[] {
	for (const name of fs.readdirSync(dir)) {
		if (name === "test" || name === "node_modules") continue;
		const full = path.join(dir, name);
		if (fs.statSync(full).isDirectory()) walkFiles(full, out);
		else if (/\.(ts|mts|js|mjs|md)$/.test(name)) out.push(full);
	}
	return out;
}

describe("ask_user_read structuredContent conformance (real execute)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-structured-read-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("list (trusted, 2 entries): schema-valid, ids absolute, total present", async () => {
		await seed(tmpDir, [
			["2026-05-15T19:00:00.000Z", "Q1", "A1"],
			["2026-05-15T20:00:00.000Z", "Q2", "A2"],
		]);
		const tools = registerTools();
		const result: any = await tools["ask_user_read"].execute(
			"c1",
			{ action: "list" },
			null,
			null,
			readCtx(tmpDir),
		);
		assert.ok(Value.Check(QnaReadOutputSchema, result.structuredContent));
		assert.strictEqual(result.structuredContent.count, 2);
		assert.strictEqual(result.structuredContent.total, 2);
		assert.deepStrictEqual(
			result.structuredContent.entries.map((e: any) => e.id),
			[1, 2],
		);
	});

	it("list (trusted, fresh dir): schema-valid empty payload with message", async () => {
		const tools = registerTools();
		const result: any = await tools["ask_user_read"].execute(
			"c1",
			{ action: "list" },
			null,
			null,
			readCtx(tmpDir),
		);
		assert.ok(Value.Check(QnaReadOutputSchema, result.structuredContent));
		assert.deepStrictEqual(result.structuredContent.entries, []);
		assert.strictEqual(result.structuredContent.count, 0);
		assert.strictEqual(result.structuredContent.total, 0);
		assert.strictEqual(result.structuredContent.message, "No Q&A history yet");
	});

	it("get (id from list result): schema-valid, entry has no id, payload has no total", async () => {
		await seed(tmpDir, [
			["2026-05-15T19:00:00.000Z", "Q1", "A1"],
			["2026-05-15T20:00:00.000Z", "Q2", "A2"],
		]);
		const tools = registerTools();
		const list: any = await tools["ask_user_read"].execute(
			"c1",
			{ action: "list" },
			null,
			null,
			readCtx(tmpDir),
		);
		const id = list.structuredContent.entries[0].id;
		const result: any = await tools["ask_user_read"].execute(
			"c2",
			{ action: "get", id },
			null,
			null,
			readCtx(tmpDir),
		);
		assert.ok(Value.Check(QnaReadOutputSchema, result.structuredContent));
		assert.strictEqual(result.structuredContent.entries.length, 1);
		assert.ok(!("id" in result.structuredContent.entries[0]));
		assert.ok(!("total" in result.structuredContent));
	});

	it("query matching: schema-valid with absolute ids", async () => {
		await seed(tmpDir, [
			["2026-05-15T19:00:00.000Z", "alpha first", "A1"],
			["2026-05-15T20:00:00.000Z", "beta", "A2"],
			["2026-05-15T21:00:00.000Z", "alpha again", "A3"],
		]);
		const tools = registerTools();
		const result: any = await tools["ask_user_read"].execute(
			"c1",
			{ action: "query", text: "alpha" },
			null,
			null,
			readCtx(tmpDir),
		);
		assert.ok(Value.Check(QnaReadOutputSchema, result.structuredContent));
		assert.strictEqual(result.structuredContent.count, 2);
		assert.deepStrictEqual(
			result.structuredContent.entries.map((e: any) => e.id),
			[1, 3],
		);
	});

	it("query no match: schema-valid empty payload", async () => {
		await seed(tmpDir, [["2026-05-15T19:00:00.000Z", "Q1", "A1"]]);
		const tools = registerTools();
		const result: any = await tools["ask_user_read"].execute(
			"c1",
			{ action: "query", text: "zzz-no-match" },
			null,
			null,
			readCtx(tmpDir),
		);
		assert.ok(Value.Check(QnaReadOutputSchema, result.structuredContent));
		assert.deepStrictEqual(result.structuredContent.entries, []);
		assert.strictEqual(result.structuredContent.count, 0);
	});

	for (const action of ["list", "get", "query"] as const) {
		it(`trust denied (${action}): typed isError signal, no string matching`, async () => {
			await seed(tmpDir, [["2026-05-15T19:00:00.000Z", "Q1", "A1"]]);
			const tools = registerTools();
			const params: any = { action };
			if (action === "get") params.id = 1;
			if (action === "query") params.text = "Q1";
			const result: any = await tools["ask_user_read"].execute(
				"c1",
				params,
				null,
				null,
				readCtx(tmpDir, false),
			);
			assert.ok(Value.Check(QnaReadOutputSchema, result.structuredContent));
			assert.strictEqual(result.isError, true);
			assert.strictEqual(result.structuredContent.trustGranted, false);
			assert.deepStrictEqual(result.structuredContent.entries, []);
			assert.strictEqual(result.structuredContent.count, 0);
			assert.ok(
				typeof result.structuredContent.message === "string" &&
					result.structuredContent.message.length > 0,
			);
		});
	}

	it("error paths reject and carry no structuredContent", async () => {
		const tools = registerTools();
		const exec = tools["ask_user_read"].execute;
		const cases: Array<[any, RegExp]> = [
			[{ action: "get" }, /id parameter is required/],
			[{ action: "get", id: null }, /id parameter is required/],
			[{ action: "query" }, /text parameter is required/],
			[{ action: "query", text: "" }, /text parameter is required/],
			[{ action: "bogus" }, /Unknown action: bogus/],
		];
		for (const [params, re] of cases) {
			await assert.rejects(() => exec("c", params, null, null, readCtx(tmpDir)), re);
		}
	});

	it("I/O error (context path is a file) rejects", async () => {
		await fs.promises.mkdir(path.join(tmpDir, ".pi"), { recursive: true });
		await fs.promises.writeFile(path.join(tmpDir, ".pi", "context"), "not a dir", "utf-8");
		const tools = registerTools();
		await assert.rejects(
			() => tools["ask_user_read"].execute("c1", { action: "list" }, null, null, readCtx(tmpDir)),
			/not a directory|ENOTDIR/,
		);
	});
});
describe("ask_user_read exact key sets per branch (real execute)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-structured-keys-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function read(params: any, trusted = true): Promise<any> {
		const tools = registerTools();
		return tools["ask_user_read"].execute("c1", params, null, null, readCtx(tmpDir, trusted));
	}

	it("list non-empty: payload and entry key sets", async () => {
		await seed(tmpDir, [["2026-05-15T19:00:00.000Z", "Q1", "A1"]]);
		const result = await read({ action: "list" });
		assert.deepStrictEqual(sortedKeys(result.structuredContent), ["count", "entries", "total"]);
		assert.deepStrictEqual(sortedKeys(result.structuredContent.entries[0]), [
			"answer",
			"datetime",
			"id",
			"question",
		]);
	});

	it("list empty: payload key set", async () => {
		const result = await read({ action: "list" });
		assert.deepStrictEqual(sortedKeys(result.structuredContent), [
			"count",
			"entries",
			"message",
			"total",
		]);
	});

	it("get: payload and entry key sets", async () => {
		await seed(tmpDir, [["2026-05-15T19:00:00.000Z", "Q1", "A1"]]);
		const result = await read({ action: "get", id: 1 });
		assert.deepStrictEqual(sortedKeys(result.structuredContent), ["count", "entries"]);
		assert.deepStrictEqual(sortedKeys(result.structuredContent.entries[0]), [
			"answer",
			"datetime",
			"question",
		]);
	});

	it("query match: payload and entry key sets", async () => {
		await seed(tmpDir, [["2026-05-15T19:00:00.000Z", "Q1", "A1"]]);
		const result = await read({ action: "query", text: "Q1" });
		assert.deepStrictEqual(sortedKeys(result.structuredContent), ["count", "entries"]);
		assert.deepStrictEqual(sortedKeys(result.structuredContent.entries[0]), [
			"answer",
			"datetime",
			"id",
			"question",
		]);
	});

	it("query no match: payload key set", async () => {
		await seed(tmpDir, [["2026-05-15T19:00:00.000Z", "Q1", "A1"]]);
		const result = await read({ action: "query", text: "nomatch" });
		assert.deepStrictEqual(sortedKeys(result.structuredContent), ["count", "entries", "message"]);
	});

	it("trust denied: payload key set guards the trustGranted name", async () => {
		const result = await read({ action: "list" }, false);
		assert.deepStrictEqual(sortedKeys(result.structuredContent), [
			"count",
			"entries",
			"message",
			"trustGranted",
		]);
	});

	it("successResult: structuredContent deep-equals details minus format (SEP-1624)", () => {
		const result = successResult(
			[{ datetime: "2026-05-15T19:00:00.000Z", question: "Q1", answer: "A1" }],
			1,
			5,
		);
		const { format, ...detailsPayload } = result.details;
		assert.strictEqual(format, "qna-result-v1");
		assert.deepStrictEqual(result.structuredContent, detailsPayload);
	});
});
describe("accepted-divergence regressions", () => {
	it("success content text is prose, not the JSON payload", () => {
		const result = successResult(
			[{ datetime: "2026-05-15T19:00:00.000Z", question: "Q", answer: "A" }],
			1,
		);
		assert.throws(() => JSON.parse(result.content[0]!.text));
	});

	it("trust-denied content text is the plain message, not JSON", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-structured-trust-"));
		try {
			const tools = registerTools();
			const result: any = await tools["ask_user_read"].execute(
				"c1",
				{ action: "list" },
				null,
				null,
				readCtx(tmpDir, false),
			);
			assert.strictEqual(
				result.content[0].text,
				"Q&A history is not available — project trust not granted",
			);
			assert.throws(() => JSON.parse(result.content[0].text));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("no JSON.parse(...text) consumer in ask-user source", () => {
		const files = walkFiles(EXT_DIR);
		assert.ok(files.length > 0, "expected to scan ask-user source files");
		const pattern = /JSON\s*\.\s*parse\s*\([^)]*\.text/;
		const offenders = files.filter((f) => pattern.test(stripComments(fs.readFileSync(f, "utf-8"))));
		assert.deepStrictEqual(offenders, [], "programmatic callers must use structuredContent");
	});

	it("README documents the trust-denied shape and prose content", () => {
		const readme = fs.readFileSync(path.join(EXT_DIR, "README.md"), "utf-8");
		assert.ok(readme.includes("trustGranted: false"));
		assert.ok(readme.toLowerCase().includes("prose"));
	});
});
