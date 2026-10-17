import assert from "node:assert";

import fs from "node:fs";

import path from "node:path";

import { fileURLToPath } from "node:url";

import { describe, it } from "node:test";

import { Value } from "typebox/value";

import { AskUserOutputSchema } from "../types.ts";

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

describe("ask_user execute — tool signal normalization (Issue #1777)", () => {
	it("signal = null: freetext resolves the answer without TypeError", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("tui", { input: async () => "typed" });

		const result: any = await tools["ask_user"].execute(
			"call1",
			{ mode: "freetext", question: "Say:" },
			null,
			null,
			ctx,
		);

		assert.strictEqual(result.structuredContent.answer, "typed");
		assert.ok(Value.Check(AskUserOutputSchema, result.structuredContent));
	});

	it("signal = undefined: freetext resolves the answer without TypeError", async () => {
		const tools = registerTools();
		const ctx = makeMockCtx("tui", { input: async () => "typed" });

		const result: any = await tools["ask_user"].execute(
			"call1",
			{ mode: "freetext", question: "Say:" },
			undefined,
			null,
			ctx,
		);

		assert.strictEqual(result.structuredContent.answer, "typed");
	});

	it("live signal is passed through to ctx.ui.input as the 3rd arg", async () => {
		const tools = registerTools();
		const controller = new AbortController();
		let capturedOpts: { signal?: AbortSignal } | undefined;
		const ctx = makeMockCtx("tui", {
			input: async (_t, _p, opts) => {
				capturedOpts = opts;
				return "typed";
			},
		});

		await tools["ask_user"].execute(
			"call1",
			{ mode: "freetext", question: "Say:" },
			controller.signal,
			null,
			ctx,
		);

		assert.strictEqual(capturedOpts?.signal, controller.signal, "same signal instance");
	});

	it("abort mid-prompt: resolves cancelled with no answer and validates schema", async () => {
		const tools = registerTools();
		const controller = new AbortController();
		const ctx = makeMockCtx("tui", {
			input: async (_t, _p, opts) =>
				new Promise<string | undefined>((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
		});

		const resultPromise = tools["ask_user"].execute(
			"call1",
			{ mode: "freetext", question: "Say:" },
			controller.signal,
			null,
			ctx,
		);

		// Execute reaches the dialog synchronously; abort before awaiting.
		controller.abort();
		const result: any = await resultPromise;

		assert.strictEqual(result.structuredContent.cancelled, true);
		assert.ok(!("answer" in result.structuredContent), "no answer on abort");
		assert.strictEqual(
			result.content[0].text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
		assert.ok(Value.Check(AskUserOutputSchema, result.structuredContent));
	});

	it("abort is indistinguishable from user cancel (no aborted marker added)", async () => {
		const tools = registerTools();
		const controller = new AbortController();
		const ctx = makeMockCtx("tui", {
			input: async (_t, _p, opts) =>
				new Promise<string | undefined>((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
		});

		const resultPromise = tools["ask_user"].execute(
			"call1",
			{ mode: "freetext", question: "Say:" },
			controller.signal,
			null,
			ctx,
		);
		controller.abort();
		const result: any = await resultPromise;

		assert.deepStrictEqual(Object.keys(result.structuredContent).sort(), [
			"cancelled",
			"mode",
			"question",
		]);
		assert.ok(!("aborted" in result.structuredContent));
	});
});
