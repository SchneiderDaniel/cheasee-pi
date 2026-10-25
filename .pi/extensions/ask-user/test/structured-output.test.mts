import assert from "node:assert";

import fs from "node:fs";

import path from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

import { Value } from "typebox/value";

import { QnaReadOutputSchema, AskUserOutputSchema } from "../types.ts";

import { appendQnaEntry } from "../jsonl-logger.ts";

import askUser from "../index.ts";

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

describe("QnaReadOutputSchema", () => {
	it("accepts a list payload (id + total)", () => {
		assert.ok(
			Value.Check(QnaReadOutputSchema, {
				entries: [{ id: 1, datetime: "2026-05-15T19:00:00.000Z", question: "Q1", answer: "A1" }],
				count: 1,
				total: 35,
			}),
		);
	});

	it("accepts a get payload (no id, no total)", () => {
		assert.ok(
			Value.Check(QnaReadOutputSchema, {
				entries: [{ datetime: "2026-05-15T19:00:00.000Z", question: "Q1", answer: "A1" }],
				count: 1,
			}),
		);
	});

	it("accepts a query payload (id, no total)", () => {
		assert.ok(
			Value.Check(QnaReadOutputSchema, {
				entries: [{ id: 7, datetime: "2026-05-15T19:00:00.000Z", question: "Q1", answer: "A1" }],
				count: 1,
			}),
		);
	});

	it("accepts an empty payload with message", () => {
		assert.ok(
			Value.Check(QnaReadOutputSchema, {
				entries: [],
				count: 0,
				message: "No Q&A history yet",
			}),
		);
	});

	it("accepts a trust-denied payload", () => {
		assert.ok(
			Value.Check(QnaReadOutputSchema, {
				entries: [],
				count: 0,
				trustGranted: false,
				message: "not granted",
			}),
		);
	});

	it("rejects a payload missing entries", () => {
		assert.equal(Value.Check(QnaReadOutputSchema, { count: 1 }), false);
	});

	it("rejects a payload with the wrong count type", () => {
		assert.equal(Value.Check(QnaReadOutputSchema, { entries: [], count: "1" }), false);
	});

	it("rejects a payload with a non-array entries field", () => {
		assert.equal(Value.Check(QnaReadOutputSchema, { entries: "x", count: 1 }), false);
	});

	it("rejects an entry missing datetime", () => {
		assert.equal(
			Value.Check(QnaReadOutputSchema, { entries: [{ question: "Q", answer: "A" }], count: 1 }),
			false,
		);
	});

	it("rejects an entry missing question", () => {
		assert.equal(
			Value.Check(QnaReadOutputSchema, { entries: [{ datetime: "d", answer: "A" }], count: 1 }),
			false,
		);
	});

	it("rejects an entry missing answer", () => {
		assert.equal(
			Value.Check(QnaReadOutputSchema, { entries: [{ datetime: "d", question: "Q" }], count: 1 }),
			false,
		);
	});
});
describe("AskUserOutputSchema", () => {
	const question = "Pick one:";

	it("accepts a freetext payload", () => {
		assert.ok(Value.Check(AskUserOutputSchema, { question, mode: "freetext", answer: "x" }));
	});

	it("accepts a choice payload", () => {
		assert.ok(
			Value.Check(AskUserOutputSchema, {
				question,
				mode: "choice",
				selected: "B",
				label: "2. B",
			}),
		);
	});

	it("accepts an other-choice payload", () => {
		assert.ok(
			Value.Check(AskUserOutputSchema, {
				question,
				mode: "choice",
				selected: "__other__",
				answer: "custom",
			}),
		);
	});

	it("accepts a cancel payload", () => {
		assert.ok(Value.Check(AskUserOutputSchema, { question, mode: "choice", cancelled: true }));
	});

	it("rejects an unknown mode", () => {
		assert.equal(Value.Check(AskUserOutputSchema, { question, mode: "quiz" }), false);
	});

	it("rejects a payload missing question", () => {
		assert.equal(Value.Check(AskUserOutputSchema, { mode: "choice" }), false);
	});

	it("rejects a payload missing mode", () => {
		assert.equal(Value.Check(AskUserOutputSchema, { question }), false);
	});
});
describe("ask_user structuredContent", () => {
	it("freetext: exposes answer and keeps content unchanged", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("tui", { input: async () => "My free answer" });

		const result: any = await tools["ask_user"].execute(
			"call1",
			{ mode: "freetext", question: "Tell me:" },
			null,
			null,
			ctx,
		);

		assert.strictEqual(result.content[0].text, 'User answered: "My free answer"');
		assert.deepStrictEqual(result.structuredContent, {
			question: "Tell me:",
			mode: "freetext",
			answer: "My free answer",
		});
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("choice: exposes selected value and label", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("tui", {
			custom: async () => "2. Option B (Recommended)",
		});

		const result: any = await tools["ask_user"].execute(
			"call1",
			{
				mode: "choice",
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "A" },
					{ label: "Option B", value: "B", recommended: true },
				],
			},
			null,
			null,
			ctx,
		);

		assert.strictEqual(result.content[0].text, 'User selected: "2. Option B (Recommended)"');
		assert.deepStrictEqual(result.structuredContent, {
			question: "Pick one:",
			mode: "choice",
			selected: "B",
			label: "2. Option B (Recommended)",
		});
	});

	it("other-choice: exposes custom answer and __other__ marker", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("tui", {
			custom: async () => "3. Other (type your answer)",
			input: async () => "custom",
		});

		const result: any = await tools["ask_user"].execute(
			"call1",
			{
				mode: "choice",
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "A" },
					{ label: "Option B", value: "B" },
				],
			},
			null,
			null,
			ctx,
		);

		assert.strictEqual(result.structuredContent.answer, "custom");
		assert.strictEqual(result.structuredContent.selected, "__other__");
	});

	it("cancel: exposes cancelled and keeps the cancel content", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("json", {});

		const result: any = await tools["ask_user"].execute(
			"call1",
			{ mode: "choice", question: "Pick one:", options: [{ label: "A", value: "a" }] },
			null,
			null,
			ctx,
		);

		assert.strictEqual(
			result.content[0].text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
		assert.strictEqual(result.structuredContent.cancelled, true);
		assert.strictEqual(result.structuredContent.mode, "choice");
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("every structuredContent validates against AskUserOutputSchema", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("tui", { input: async () => "typed" });

		const result: any = await tools["ask_user"].execute(
			"call1",
			{ mode: "freetext", question: "Say:" },
			null,
			null,
			ctx,
		);

		assert.ok(Value.Check(AskUserOutputSchema, result.structuredContent));
	});

	it("freetext: exact keys, trimmed answer, prose content", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("tui", { input: async () => "  spaced answer  " });

		const result: any = await tools["ask_user"].execute(
			"call1",
			{ mode: "freetext", question: "Tell me:" },
			null,
			null,
			ctx,
		);

		assert.ok(Value.Check(AskUserOutputSchema, result.structuredContent));
		assert.deepStrictEqual(Object.keys(result.structuredContent).sort(), [
			"answer",
			"mode",
			"question",
		]);
		assert.strictEqual(result.structuredContent.answer, "spaced answer");
		assert.ok(!result.content[0].text.startsWith("{"));
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("choice: exact keys, selected is the option value not the label", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("tui", { custom: async () => "2. Option B (Recommended)" });

		const result: any = await tools["ask_user"].execute(
			"call1",
			{
				mode: "choice",
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "A" },
					{ label: "Option B", value: "B", recommended: true },
				],
			},
			null,
			null,
			ctx,
		);

		assert.ok(Value.Check(AskUserOutputSchema, result.structuredContent));
		assert.deepStrictEqual(Object.keys(result.structuredContent).sort(), [
			"label",
			"mode",
			"question",
			"selected",
		]);
		assert.strictEqual(result.structuredContent.selected, "B");
		assert.ok(!result.content[0].text.startsWith("{"));
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("other-choice with text: exact keys", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("tui", {
			custom: async () => "3. Other (type your answer)",
			input: async () => "custom",
		});

		const result: any = await tools["ask_user"].execute(
			"call1",
			{
				mode: "choice",
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "A" },
					{ label: "Option B", value: "B" },
				],
			},
			null,
			null,
			ctx,
		);

		assert.ok(Value.Check(AskUserOutputSchema, result.structuredContent));
		assert.deepStrictEqual(Object.keys(result.structuredContent).sort(), [
			"answer",
			"mode",
			"question",
			"selected",
		]);
		assert.strictEqual(result.structuredContent.selected, "__other__");
		assert.strictEqual(result.structuredContent.answer, "custom");
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("other-choice with empty input: cancelled shape", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("tui", {
			custom: async () => "3. Other (type your answer)",
			input: async () => "   ",
		});

		const result: any = await tools["ask_user"].execute(
			"call1",
			{
				mode: "choice",
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "A" },
					{ label: "Option B", value: "B" },
				],
			},
			null,
			null,
			ctx,
		);

		assert.ok(Value.Check(AskUserOutputSchema, result.structuredContent));
		assert.deepStrictEqual(Object.keys(result.structuredContent).sort(), [
			"cancelled",
			"mode",
			"question",
		]);
		assert.strictEqual(result.structuredContent.cancelled, true);
		assert.ok(!result.content[0].text.startsWith("{"));
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("json cancel with omitted mode defaults to choice", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("json", {});

		const result: any = await tools["ask_user"].execute(
			"call1",
			{ question: "Pick one:", options: [{ label: "A", value: "a" }] },
			null,
			null,
			ctx,
		);

		assert.ok(Value.Check(AskUserOutputSchema, result.structuredContent));
		assert.deepStrictEqual(Object.keys(result.structuredContent).sort(), [
			"cancelled",
			"mode",
			"question",
		]);
		assert.strictEqual(result.structuredContent.cancelled, true);
		assert.strictEqual(result.structuredContent.mode, "choice");
		assert.strictEqual(result.details.format, "qna-result-v1");
	});
});
