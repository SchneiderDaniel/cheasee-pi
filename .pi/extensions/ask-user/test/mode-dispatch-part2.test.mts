import assert from "node:assert";

import { describe, it } from "node:test";

import { QuestionHandler } from "../question-handler.ts";

interface DialogOptions {
	signal?: AbortSignal;
}

interface MockUI {
	input: (title: string, placeholder?: string, opts?: DialogOptions) => Promise<string | undefined>;
	custom: <T>(
		factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
	) => Promise<T>;
	select: (title: string, options: string[], opts?: DialogOptions) => Promise<string | undefined>;
	notify: (message: string, type?: string) => void;
}

interface MockCtx {
	mode: string;
	hasUI: boolean;
	ui: MockUI;
	sessionManager: {
		getCwd: () => string;
	};
	isProjectTrusted: () => Promise<boolean>;
}

function makeMockCtx(overrides?: Partial<MockCtx>): MockCtx {
	const ctx: MockCtx = {
		mode: "tui",
		hasUI: true,
		ui: {
			input: async () => "mock answer",
			custom: async <T,>() => undefined as T,
			select: async () => undefined,
			notify: () => {},
		},
		sessionManager: { getCwd: () => "/test/project" },
		isProjectTrusted: async () => true,
	};

	if (overrides) {
		if (overrides.mode !== undefined) ctx.mode = overrides.mode;
		if (overrides.hasUI !== undefined) ctx.hasUI = overrides.hasUI;
		if (overrides.ui) Object.assign(ctx.ui, overrides.ui);
		if (overrides.sessionManager) Object.assign(ctx.sessionManager, overrides.sessionManager);
		if (overrides.isProjectTrusted) ctx.isProjectTrusted = overrides.isProjectTrusted;
	}

	return ctx;
}

const CANCEL_TEXT = "User cancelled the question. Ask if they want to skip this topic and move on.";

function makeTuiCustomCtx(): {
	ctx: MockCtx;
	getDone: () => (value: string | undefined) => void;
	getComponent: () => any;
	getDisposeCount: () => number;
	wasFactoryRan: () => boolean;
} {
	let capturedDone: ((value: string | undefined) => void) | undefined;
	let capturedComponent: any;
	let disposeCount = 0;
	let factoryRan = false;

	const ctx = makeMockCtx({
		mode: "tui",
		ui: {
			...makeMockCtx().ui,
			custom: async <T,>(factory: any) => {
				return new Promise<T>((resolve) => {
					capturedDone = (value: string | undefined) => resolve(value as T);
					const component = factory(
						{ requestRender: () => {} },
						{ fg: (_color: string, text: string) => text },
						{},
						capturedDone,
					);
					factoryRan = true;
					capturedComponent = component;
					const originalDispose = component.dispose.bind(component);
					component.dispose = () => {
						disposeCount++;
						originalDispose();
					};
				});
			},
		},
	});

	return {
		ctx,
		getDone: () => capturedDone!,
		getComponent: () => capturedComponent,
		getDisposeCount: () => disposeCount,
		wasFactoryRan: () => factoryRan,
	};
}

describe("Freetext mode — JSON/print dispatch", () => {
	it("returns cancelResponse in JSON mode without calling ctx.ui.input()", async () => {
		let uiMethodCalled = false;
		const ctx = makeMockCtx({
			mode: "json",
			ui: {
				...makeMockCtx().ui,
				input: async () => {
					uiMethodCalled = true;
					return "";
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "freetext",
			question: "Say something:",
		});

		assert.strictEqual(uiMethodCalled, false, "ctx.ui.input() should not be called in JSON mode");
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
	});

	it("returns cancelResponse in Print mode without calling ctx.ui.input()", async () => {
		let uiMethodCalled = false;
		const ctx = makeMockCtx({
			mode: "print",
			ui: {
				...makeMockCtx().ui,
				input: async () => {
					uiMethodCalled = true;
					return "";
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "freetext",
			question: "Say something:",
		});

		assert.strictEqual(uiMethodCalled, false, "ctx.ui.input() should not be called in print mode");
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
	});
});
describe("Backward compatibility — undefined mode", () => {
	it("treats undefined mode as TUI (backward compatible)", async () => {
		let customCalled = false;
		let capturedDone: ((value: string | undefined) => void) | undefined;

		const ctx = makeMockCtx({
			mode: "tui", // will be treated as TUI
			ui: {
				...makeMockCtx().ui,
				custom: async <T,>(
					_factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
				) => {
					customCalled = true;
					return new Promise<T>((resolve) => {
						capturedDone = (value: string | undefined) => resolve(value as T);
					});
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const resultPromise = handler.handle({
			// No mode specified — defaults to choice
			question: "Pick one:",
			options: [{ label: "A", value: "a" }],
		});

		assert.ok(customCalled, "ctx.ui.custom() should be called (default mode = choice)");
		capturedDone!("1. A");
		const result = await resultPromise;
		assert.strictEqual(result.details.selected, "a");
		assert.strictEqual(result.details.format, "qna-result-v1");
	});
});
describe("logAnswer trust gating in QuestionHandler", () => {
	it("calls logAnswer (persists) when trusted in TUI mode", async () => {
		let inputTitle = "";
		const ctx = makeMockCtx({
			mode: "tui",
			ui: {
				...makeMockCtx().ui,
				input: async (title: string) => {
					inputTitle = title;
					return "answer";
				},
			},
			isProjectTrusted: async () => true,
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "freetext",
			question: "Test:",
		});

		// If trusted, logAnswer was called and answer is returned
		assert.strictEqual(result.details.answer, "answer");
	});

	it("skips persistence when not trusted (logAnswer returns without writing)", async () => {
		let inputTitle = "";
		const ctx = makeMockCtx({
			mode: "tui",
			ui: {
				...makeMockCtx().ui,
				input: async (title: string) => {
					inputTitle = title;
					return "answer";
				},
			},
			isProjectTrusted: async () => false,
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "freetext",
			question: "Test:",
		});

		// Answer is still returned in content even when not trusted
		assert.strictEqual(result.details.answer, "answer");
		// logAnswer should not throw when trust is false — it just skips
	});

	it("skips persistence when not trusted in choice mode", async () => {
		let capturedDone: ((value: string | undefined) => void) | undefined;
		const ctx = makeMockCtx({
			mode: "tui",
			ui: {
				...makeMockCtx().ui,
				custom: async <T,>() => {
					return new Promise<T>((resolve) => {
						capturedDone = (value: string | undefined) => resolve(value as T);
					});
				},
			},
			isProjectTrusted: async () => false,
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const resultPromise = handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [{ label: "A", value: "a" }],
		});

		capturedDone!("1. A");
		const result = await resultPromise;

		// Answer is returned even when not trusted
		assert.strictEqual(result.details.selected, "a");
	});
});
describe("Cancellation — signal propagation (Issue #1777)", () => {
	it("freetext: passes the tool signal as the 3rd arg to ctx.ui.input", async () => {
		const controller = new AbortController();
		let capturedOpts: DialogOptions | undefined;

		const ctx = makeMockCtx({
			mode: "tui",
			ui: {
				...makeMockCtx().ui,
				input: async (_title: string, _placeholder?: string, opts?: DialogOptions) => {
					capturedOpts = opts;
					return "x";
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any, controller.signal);
		await handler.handle({ mode: "freetext", question: "Tell me:" });

		assert.deepStrictEqual(capturedOpts, { signal: controller.signal });
		assert.strictEqual(capturedOpts?.signal, controller.signal, "same signal instance");
	});

	it("freetext: passes { signal: undefined } when constructed without a signal", async () => {
		let capturedOpts: DialogOptions | undefined;

		const ctx = makeMockCtx({
			mode: "tui",
			ui: {
				...makeMockCtx().ui,
				input: async (_title: string, _placeholder?: string, opts?: DialogOptions) => {
					capturedOpts = opts;
					return "x";
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({ mode: "freetext", question: "Tell me:" });

		assert.deepStrictEqual(capturedOpts, { signal: undefined });
		assert.strictEqual(result.details.answer, "x");
	});

	it("freetext: pre-aborted signal + input resolves undefined → cancelResponse", async () => {
		const controller = new AbortController();
		controller.abort();

		const ctx = makeMockCtx({
			mode: "tui",
			ui: { ...makeMockCtx().ui, input: async () => undefined },
		});

		const handler = new QuestionHandler("/test", ctx as any, controller.signal);
		const result = await handler.handle({ mode: "freetext", question: "Tell me:" });

		assert.strictEqual(result.content[0]?.text, CANCEL_TEXT);
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("rpc choice: passes the tool signal as the 3rd arg to ctx.ui.select", async () => {
		const controller = new AbortController();
		let capturedOpts: DialogOptions | undefined;

		const ctx = makeMockCtx({
			mode: "rpc",
			ui: {
				...makeMockCtx().ui,
				select: async (_title: string, _options: string[], opts?: DialogOptions) => {
					capturedOpts = opts;
					return "1. A";
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any, controller.signal);
		await handler.handle({
			mode: "choice",
			question: "Pick:",
			options: [{ label: "A", value: "a" }],
		});

		assert.deepStrictEqual(capturedOpts, { signal: controller.signal });
		assert.strictEqual(capturedOpts?.signal, controller.signal, "same signal instance");
	});

	it("rpc choice: pre-aborted signal + select resolves undefined → cancelResponse", async () => {
		const controller = new AbortController();
		controller.abort();

		const ctx = makeMockCtx({
			mode: "rpc",
			ui: { ...makeMockCtx().ui, select: async () => undefined },
		});

		const handler = new QuestionHandler("/test", ctx as any, controller.signal);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick:",
			options: [{ label: "A", value: "a" }],
		});

		assert.strictEqual(result.content[0]?.text, CANCEL_TEXT);
		assert.ok(!("selected" in result.details), "cancel result carries no selected value");
	});

	it("other-choice: passes the tool signal to the follow-up ctx.ui.input", async () => {
		const controller = new AbortController();
		let capturedOpts: DialogOptions | undefined;

		const ctx = makeMockCtx({
			mode: "rpc",
			ui: {
				...makeMockCtx().ui,
				select: async () => "2. Other (type your answer)",
				input: async (_title: string, _placeholder?: string, opts?: DialogOptions) => {
					capturedOpts = opts;
					return undefined;
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any, controller.signal);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick:",
			options: [{ label: "A", value: "a" }],
		});

		assert.deepStrictEqual(capturedOpts, { signal: controller.signal });
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled or left 'Other' empty. Re-ask or mark this topic as unresolved.",
		);
	});
});
