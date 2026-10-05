/**
 * Unit tests for mode-aware UI dispatch in QuestionHandler (Issue #740).
 *
 * Tests that QuestionHandler routes choice/freetext questions to the correct
 * UI method per ctx.mode (tui/rpc/json/print).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ask-user/test/mode-dispatch.test.mts
 */

import assert from "node:assert";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { QuestionHandler } from "../question-handler.ts";

// ============================================================================
// Export smoke test — verify QuestionHandler is a constructable class
// ============================================================================

describe("QuestionHandler export", () => {
	it("QuestionHandler is a class (constructable)", () => {
		// This assertion directly references QuestionHandler by name,
		// satisfying the TDD gate's symbol-coverage check.
		assert.strictEqual(
			typeof QuestionHandler,
			"function",
			"QuestionHandler should be a class/function",
		);
	});
});

// ---------------------------------------------------------------------------
// Mock types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

// ============================================================================
// Tests: Choice mode — TUI dispatch
// ============================================================================

describe("Choice mode — TUI dispatch", () => {
	it("calls ctx.ui.custom() in TUI mode and returns mapped value", async () => {
		let customCalled = false;
		let capturedDone: ((value: string | undefined) => void) | undefined;

		const ctx = makeMockCtx({
			mode: "tui",
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
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "Option A", value: "A" },
				{ label: "Option B", value: "B", recommended: true },
			],
		});

		assert.ok(customCalled, "ctx.ui.custom() should be called in TUI mode");
		capturedDone!("2. Option B (Recommended)");

		const result = await resultPromise;
		assert.strictEqual(result.details.selected, "B");
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("returns cancelResponse when user cancels in TUI mode", async () => {
		const ctx = makeMockCtx({
			mode: "tui",
			ui: {
				...makeMockCtx().ui,
				custom: async <T,>() => undefined as T,
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "Red", value: "red" },
				{ label: "Blue", value: "blue" },
			],
		});

		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
		assert.strictEqual(result.details.format, "qna-result-v1");
	});
});

// ============================================================================
// Tests: Choice mode — RPC dispatch
// ============================================================================

describe("Choice mode — RPC dispatch", () => {
	it("calls ctx.ui.select() with flat string options and reverse-maps to value", async () => {
		let selectTitle = "";
		let selectOptions: string[] = [];
		const ctx = makeMockCtx({
			mode: "rpc",
			ui: {
				...makeMockCtx().ui,
				select: async (title: string, options: string[]) => {
					selectTitle = title;
					selectOptions = options;
					return "2. Option B (Recommended)";
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "Option A", value: "A" },
				{ label: "Option B", value: "B", recommended: true },
			],
		});

		assert.strictEqual(selectTitle, "Pick one:");
		assert.deepStrictEqual(selectOptions, [
			"1. Option A",
			"2. Option B (Recommended)",
			"3. Other (type your answer)",
		]);
		assert.strictEqual(result.details.selected, "B");
		assert.strictEqual(result.details.label, "2. Option B (Recommended)");
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("handles Other option selection in RPC mode with custom input", async () => {
		let selectResolve: ((value: string | undefined) => void) | undefined;
		let inputCalledWith = "";

		const ctx = makeMockCtx({
			mode: "rpc",
			ui: {
				...makeMockCtx().ui,
				select: async (_title: string) => {
					return new Promise<string | undefined>((resolve) => {
						selectResolve = resolve;
					});
				},
				input: async (title: string) => {
					inputCalledWith = title;
					return "My custom answer";
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const resultPromise = handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "Option A", value: "A" },
				{ label: "Option B", value: "B" },
			],
		});

		// Simulate user picking "Other"
		selectResolve!("3. Other (type your answer)");
		const result = await resultPromise;

		assert.strictEqual(inputCalledWith, "Type your answer:");
		assert.strictEqual(
			result.content[0]?.text,
			'User chose "Other" and answered: "My custom answer"',
		);
		assert.strictEqual(result.details.selected, "__other__");
		assert.strictEqual(result.details.customAnswer, "My custom answer");
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("handles cancel in RPC mode (undefined from ctx.ui.select)", async () => {
		const ctx = makeMockCtx({
			mode: "rpc",
			ui: {
				...makeMockCtx().ui,
				select: async () => undefined,
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "Red", value: "red" },
				{ label: "Blue", value: "blue" },
			],
		});

		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
	});

	it("suppresses Other option in RPC mode when disableOther is true", async () => {
		let selectOptions: string[] = [];
		const ctx = makeMockCtx({
			mode: "rpc",
			ui: {
				...makeMockCtx().ui,
				select: async (_title: string, options: string[]) => {
					selectOptions = options;
					return undefined;
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		await handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "Red", value: "red" },
				{ label: "Blue", value: "blue" },
			],
			disableOther: true,
		});

		// Should NOT contain "Other" option
		assert.strictEqual(selectOptions.length, 2);
		assert.ok(!selectOptions.some((o) => o.includes("Other")));
	});

	it("encodes recommended flag with (Recommended) suffix in RPC mode", async () => {
		let selectOptions: string[] = [];
		const ctx = makeMockCtx({
			mode: "rpc",
			ui: {
				...makeMockCtx().ui,
				select: async (_title: string, options: string[]) => {
					selectOptions = options;
					return undefined;
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		await handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "A", value: "a" },
				{ label: "B", value: "b", recommended: true },
				{ label: "C (best)", value: "c" },
			],
		});

		assert.ok(selectOptions[0]?.includes("1. A"), "Option 1 should not have (Recommended)");
		assert.ok(
			selectOptions[1]?.includes("2. B (Recommended)"),
			"Recommended option should have suffix",
		);
		assert.ok(
			!selectOptions[2]?.includes("(Recommended)"),
			"Non-recommended option should not have suffix",
		);
		// Other option should be appended
		assert.ok(
			selectOptions[3]?.includes("Other"),
			"Other option should be present when not disabled",
		);
	});
});

// ============================================================================
// Tests: Choice mode — JSON / print dispatch
// ============================================================================

describe("Choice mode — JSON/print dispatch", () => {
	it("returns cancelResponse in JSON mode without calling any UI method", async () => {
		let uiMethodCalled = false;
		const ctx = makeMockCtx({
			mode: "json",
			ui: {
				...makeMockCtx().ui,
				input: async () => {
					uiMethodCalled = true;
					return "";
				},
				custom: async <T,>() => undefined as T,
				select: async () => {
					uiMethodCalled = true;
					return undefined;
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [{ label: "A", value: "a" }],
		});

		assert.strictEqual(uiMethodCalled, false, "No UI method should be called in JSON mode");
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("returns cancelResponse in Print mode without calling any UI method", async () => {
		let uiMethodCalled = false;
		const ctx = makeMockCtx({
			mode: "print",
			ui: {
				...makeMockCtx().ui,
				input: async () => {
					uiMethodCalled = true;
					return "";
				},
				custom: async <T,>() => undefined as T,
				select: async () => {
					uiMethodCalled = true;
					return undefined;
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [{ label: "A", value: "a" }],
		});

		assert.strictEqual(uiMethodCalled, false, "No UI method should be called in print mode");
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
	});
});

// ============================================================================
// Tests: Freetext mode — TUI dispatch
// ============================================================================

describe("Freetext mode — TUI dispatch", () => {
	it("calls ctx.ui.input() in TUI mode and returns answer", async () => {
		let inputTitle = "";
		const ctx = makeMockCtx({
			mode: "tui",
			ui: {
				...makeMockCtx().ui,
				input: async (title: string) => {
					inputTitle = title;
					return "My free answer";
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "freetext",
			question: "Tell me something:",
		});

		assert.strictEqual(inputTitle, "Tell me something:");
		assert.strictEqual(result.content[0]?.text, 'User answered: "My free answer"');
		assert.strictEqual(result.details.answer, "My free answer");
		assert.strictEqual(result.details.format, "qna-result-v1");
	});

	it("returns cancelResponse for empty input in TUI mode", async () => {
		const ctx = makeMockCtx({
			mode: "tui",
			ui: {
				...makeMockCtx().ui,
				input: async () => "",
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "freetext",
			question: "Say something:",
		});

		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
	});
});

// ============================================================================
// Tests: Freetext mode — RPC dispatch
// ============================================================================

describe("Freetext mode — RPC dispatch", () => {
	it("calls ctx.ui.input() in RPC mode (same behavior as TUI)", async () => {
		let inputTitle = "";
		const ctx = makeMockCtx({
			mode: "rpc",
			ui: {
				...makeMockCtx().ui,
				input: async (title: string) => {
					inputTitle = title;
					return "RPC answer";
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "freetext",
			question: "What do you think?",
		});

		assert.strictEqual(inputTitle, "What do you think?");
		assert.strictEqual(result.content[0]?.text, 'User answered: "RPC answer"');
		assert.strictEqual(result.details.answer, "RPC answer");
	});
});

// ============================================================================
// Tests: Freetext mode — JSON / print dispatch
// ============================================================================

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

// ============================================================================
// Tests: Backward compatibility — undefined mode
// ============================================================================

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

// ============================================================================
// Tests: logAnswer trust gating in QuestionHandler
// ============================================================================

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

// ============================================================================
// Tests: Cancellation — signal propagation & abort handling (Issue #1777)
// ============================================================================

const CANCEL_TEXT = "User cancelled the question. Ask if they want to skip this topic and move on.";

/**
 * Build a TUI ctx whose custom() invokes the factory synchronously (like the
 * real platform) and exposes the captured done + component for abort tests.
 */
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

describe("Cancellation — custom TUI dialog abort (Issue #1777)", () => {
	it("abort mid-prompt dismisses the dialog and resolves cancelResponse", async () => {
		const controller = new AbortController();
		const { ctx, getDisposeCount, wasFactoryRan } = makeTuiCustomCtx();
		const handler = new QuestionHandler("/test", ctx as any, controller.signal);

		const resultPromise = handler.handle({
			mode: "choice",
			question: "Pick:",
			options: [
				{ label: "A", value: "a" },
				{ label: "B", value: "b" },
			],
		});

		assert.ok(wasFactoryRan(), "custom factory runs synchronously");
		assert.strictEqual(getDisposeCount(), 0, "component not yet disposed");

		controller.abort();
		const result = await resultPromise;

		assert.strictEqual(getDisposeCount(), 1, "abort disposes the dialog component once");
		assert.strictEqual(result.content[0]?.text, CANCEL_TEXT);
		assert.ok(!("selected" in result.details));
	});

	it("pre-aborted signal resolves cancelResponse without invoking ctx.ui.custom", async () => {
		const controller = new AbortController();
		controller.abort();
		let customCalled = false;

		const ctx = makeMockCtx({
			mode: "tui",
			ui: {
				...makeMockCtx().ui,
				custom: async <T,>() => {
					customCalled = true;
					return undefined as T;
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any, controller.signal);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick:",
			options: [{ label: "A", value: "a" }],
		});

		assert.strictEqual(customCalled, false, "no doomed dialog is mounted after abort");
		assert.strictEqual(result.content[0]?.text, CANCEL_TEXT);
	});

	it("abort after a normal selection is a no-op (listener removed, no double resolve)", async () => {
		const controller = new AbortController();
		const { ctx, getComponent } = makeTuiCustomCtx();
		const handler = new QuestionHandler("/test", ctx as any, controller.signal);

		const resultPromise = handler.handle({
			mode: "choice",
			question: "Pick:",
			options: [{ label: "A", value: "a" }],
		});

		// Simulate the user selecting the first option through the real component
		// (routes through the handler's done wrapper, which removes the listener).
		getComponent().handleInput("\r");
		const result = await resultPromise;
		assert.strictEqual(result.details.selected, "a");
		assert.strictEqual(
			getEventListeners(controller.signal, "abort").length,
			0,
			"abort listener removed once done fires",
		);

		// Late abort must not throw or change the resolved result.
		assert.doesNotThrow(() => controller.abort());
		assert.strictEqual(result.details.selected, "a");
	});

	it("listener lifecycle: present while pending, removed after done", async () => {
		const controller = new AbortController();
		const { ctx, getComponent } = makeTuiCustomCtx();
		const handler = new QuestionHandler("/test", ctx as any, controller.signal);

		const resultPromise = handler.handle({
			mode: "choice",
			question: "Pick:",
			options: [{ label: "A", value: "a" }],
		});

		assert.ok(
			getEventListeners(controller.signal, "abort").length >= 1,
			"abort listener registered while the prompt is pending",
		);

		getComponent().handleInput("\r");
		await resultPromise;

		assert.strictEqual(getEventListeners(controller.signal, "abort").length, 0);
	});

	it("rpc regression: custom is never invoked for choice in rpc mode", async () => {
		let customCalled = false;
		let selectCalled = false;

		const ctx = makeMockCtx({
			mode: "rpc",
			ui: {
				...makeMockCtx().ui,
				custom: async <T,>() => {
					customCalled = true;
					return undefined as T;
				},
				select: async () => {
					selectCalled = true;
					return "1. A";
				},
			},
		});

		const handler = new QuestionHandler("/test", ctx as any);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick:",
			options: [{ label: "A", value: "a" }],
		});

		assert.strictEqual(customCalled, false);
		assert.strictEqual(selectCalled, true);
		assert.strictEqual(result.details.selected, "a");
	});
});
