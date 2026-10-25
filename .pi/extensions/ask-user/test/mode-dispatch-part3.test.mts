import assert from "node:assert";

import { getEventListeners } from "node:events";

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
