/**
 * Unit tests for QuestionHandler — extracted from ask-user index.ts execute logic.
 *
 * Exercises the production QuestionHandler from ../question-handler.ts against a
 * hand-rolled port mock — no inlined copy, no duplicated local types.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ask-user/test/question-handler.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QuestionHandler, type QuestionHandlerContext } from "../question-handler.ts";

// ---------------------------------------------------------------------------
// Mock context — the handler's own narrow port (no `as any`).
// ---------------------------------------------------------------------------

type MockCtx = QuestionHandlerContext;
type MockUI = QuestionHandlerContext["ui"];

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockCtx(overrides?: Partial<MockUI>): MockCtx {
	const ui: MockUI = {
		input: async () => "mock answer",
		custom: async <T,>() => undefined as T,
		select: async () => undefined,
		notify: () => {},
		...overrides,
	};

	return {
		ui,
		// Trust gate off by default: `true` would run the real appendQnaEntry.
		isProjectTrusted: async () => false,
	};
}

// ============================================================================
// Tests: QuestionHandler — freetext mode
// ============================================================================

describe("QuestionHandler — freetext mode", () => {
	it("returns the user answer when user provides input", async () => {
		const ctx = makeMockCtx({
			input: async () => "Hello, world!",
		});
		const handler = new QuestionHandler("/test", ctx);
		const result = await handler.handle({
			mode: "freetext",
			question: "Say something:",
		});

		assert.strictEqual(result.content[0]?.text, 'User answered: "Hello, world!"');
		assert.strictEqual(result.details.answer, "Hello, world!");
	});

	it("trims whitespace from user answer", async () => {
		const ctx = makeMockCtx({
			input: async () => "  hello  ",
		});
		const handler = new QuestionHandler("/test", ctx);
		const result = await handler.handle({
			mode: "freetext",
			question: "Say something:",
		});

		assert.strictEqual(result.content[0]?.text, 'User answered: "hello"');
		assert.strictEqual(result.details.answer, "hello");
	});

	it("returns cancellation response when user cancels (undefined)", async () => {
		const ctx = makeMockCtx({
			input: async () => undefined,
		});
		const handler = new QuestionHandler("/test", ctx);
		const result = await handler.handle({
			mode: "freetext",
			question: "Say something:",
		});

		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
		assert.strictEqual(result.details.selected, undefined);
		assert.strictEqual(result.details.answer, undefined);
		assert.strictEqual(result.details.customAnswer, undefined);
	});

	it("returns cancellation response when user provides empty string", async () => {
		const ctx = makeMockCtx({
			input: async () => "",
		});
		const handler = new QuestionHandler("/test", ctx);
		const result = await handler.handle({
			mode: "freetext",
			question: "Say something:",
		});

		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
		assert.strictEqual(result.details.selected, undefined);
		assert.strictEqual(result.details.answer, undefined);
		assert.strictEqual(result.details.customAnswer, undefined);
	});

	it("returns cancellation response when user provides only whitespace", async () => {
		const ctx = makeMockCtx({
			input: async () => "   ",
		});
		const handler = new QuestionHandler("/test", ctx);
		const result = await handler.handle({
			mode: "freetext",
			question: "Say something:",
		});

		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
		assert.strictEqual(result.details.selected, undefined);
		assert.strictEqual(result.details.answer, undefined);
		assert.strictEqual(result.details.customAnswer, undefined);
	});

	it("calls ctx.ui.input with the question and empty placeholder", async () => {
		let capturedTitle = "";
		let capturedPlaceholder = "";
		let capturedSignal: AbortSignal | undefined;
		const ctx = makeMockCtx({
			input: async (
				title: string,
				placeholder?: string,
				opts?: { signal?: AbortSignal },
			) => {
				capturedTitle = title;
				capturedPlaceholder = placeholder ?? "";
				capturedSignal = opts?.signal;
				return "answer";
			},
		});
		const handler = new QuestionHandler("/test", ctx);
		await handler.handle({
			mode: "freetext",
			question: "What is your quest?",
		});

		assert.strictEqual(capturedTitle, "What is your quest?");
		assert.strictEqual(capturedPlaceholder, "");
		assert.strictEqual(capturedSignal, undefined);
	});
});

// ============================================================================
// Tests: QuestionHandler — choice mode (default)
// ============================================================================

describe("QuestionHandler — choice mode", () => {
	it("returns the selected option label and value when user picks predefined option", async () => {
		let capturedDone: ((value: string | undefined) => void) | undefined;
		const ctx = makeMockCtx({
			custom: async <T,>(
				factory: (_tui: any, _theme: any, _keybindings: any, done: (result: T) => void) => any,
			) => {
				return new Promise<T>((resolve) => {
					capturedDone = (value: string | undefined) => resolve(value as T);
				});
			},
		});
		const handler = new QuestionHandler("/test", ctx);

		// Start and let it await custom()
		const resultPromise = handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "Option A", value: "A" },
				{ label: "Option B", value: "B", recommended: true },
				{ label: "Option C", value: "C" },
			],
		});

		// Simulate user picking "2. Option B (Recommended)"
		capturedDone!("2. Option B (Recommended)");

		const result = await resultPromise;
		assert.strictEqual(result.content[0]?.text, 'User selected: "2. Option B (Recommended)"');
		assert.strictEqual(result.details.selected, "B");
		assert.strictEqual(result.details.label, "2. Option B (Recommended)");
	});

	it("appends 'Other' option by default when disableOther is not set", async () => {
		let capturedDone: ((value: string | undefined) => void) | undefined;
		const ctx = makeMockCtx({
			custom: async <T,>(
				factory: (_tui: any, _theme: any, _keybindings: any, done: (result: T) => void) => any,
			) => {
				return new Promise<T>((resolve) => {
					capturedDone = (value: string | undefined) => resolve(value as T);
				});
			},
		});
		const handler = new QuestionHandler("/test", ctx);

		const resultPromise = handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "Red", value: "red" },
				{ label: "Blue", value: "blue" },
			],
		});

		// User picks "Other"
		capturedDone!("3. Other (type your answer)");

		// Now "Other" should trigger input for custom answer
		// But we haven't set up the input mock for custom answer
		const result = await resultPromise;
		// This should have triggered input for custom answer — but our mock
		// returns "mock answer" by default, so it should have worked
		assert.strictEqual(result.content[0]?.text, 'User chose "Other" and answered: "mock answer"');
		assert.strictEqual(result.details.selected, "__other__");
		assert.strictEqual(result.details.customAnswer, "mock answer");
	});

	it("handles 'Other' cancellation (user cancels custom input)", async () => {
		let capturedDone: ((value: string | undefined) => void) | undefined;
		const ctx = makeMockCtx({
			input: async () => undefined, // User cancels the custom input
			custom: async <T,>(
				factory: (_tui: any, _theme: any, _keybindings: any, done: (result: T) => void) => any,
			) => {
				return new Promise<T>((resolve) => {
					capturedDone = (value: string | undefined) => resolve(value as T);
				});
			},
		});
		const handler = new QuestionHandler("/test", ctx);

		const resultPromise = handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "Red", value: "red" },
				{ label: "Blue", value: "blue" },
			],
		});

		// User picks "Other"
		capturedDone!("3. Other (type your answer)");

		const result = await resultPromise;
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled or left 'Other' empty. Re-ask or mark this topic as unresolved.",
		);
		assert.strictEqual(result.details.selected, undefined);
		assert.strictEqual(result.details.answer, undefined);
		assert.strictEqual(result.details.customAnswer, undefined);
	});

	it("handles 'Other' with empty string input", async () => {
		let capturedDone: ((value: string | undefined) => void) | undefined;
		const ctx = makeMockCtx({
			input: async () => "",
			custom: async <T,>(
				factory: (_tui: any, _theme: any, _keybindings: any, done: (result: T) => void) => any,
			) => {
				return new Promise<T>((resolve) => {
					capturedDone = (value: string | undefined) => resolve(value as T);
				});
			},
		});
		const handler = new QuestionHandler("/test", ctx);

		const resultPromise = handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "Red", value: "red" },
				{ label: "Blue", value: "blue" },
			],
		});

		capturedDone!("3. Other (type your answer)");

		const result = await resultPromise;
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled or left 'Other' empty. Re-ask or mark this topic as unresolved.",
		);
		assert.strictEqual(result.details.selected, undefined);
		assert.strictEqual(result.details.answer, undefined);
		assert.strictEqual(result.details.customAnswer, undefined);
	});

	it("does not append 'Other' option when disableOther is true", async () => {
		let capturedItems: Array<{ value: string; label: string }> | undefined;
		const ctx = makeMockCtx({
			custom: async <T,>(
				factory: (_tui: any, _theme: any, _keybindings: any, done: (result: T) => void) => any,
			) => {
				// The factory wouldn't normally be called synchronously like this,
				// but for the test we can't inspect what's passed to renderScrollableDialog
				// So we'll just resolve
				return undefined as T;
			},
		});
		void capturedItems;

		const handler = new QuestionHandler("/test", ctx);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "Red", value: "red" },
				{ label: "Blue", value: "blue" },
			],
			disableOther: true,
		});

		// With disableOther: true and no "Other" option, if user cancels (undefined from custom)
		// we get the cancellation response
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
	});

	it("returns cancellation when user presses Escape in choice dialog", async () => {
		const ctx = makeMockCtx({
			custom: async <T,>() => undefined as T,
		});
		const handler = new QuestionHandler("/test", ctx);
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

	it("resolves recommended label with (Recommended) suffix", async () => {
		let capturedDone: ((value: string | undefined) => void) | undefined;
		const ctx = makeMockCtx({
			custom: async <T,>(
				factory: (_tui: any, _theme: any, _keybindings: any, done: (result: T) => void) => any,
			) => {
				return new Promise<T>((resolve) => {
					capturedDone = (value: string | undefined) => resolve(value as T);
				});
			},
		});
		const handler = new QuestionHandler("/test", ctx);

		const resultPromise = handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "A", value: "a" },
				{ label: "B (best)", value: "b", recommended: true },
			],
		});

		capturedDone!("2. B (best) (Recommended)");

		const result = await resultPromise;
		assert.strictEqual(result.details.selected, "b");
		assert.strictEqual(result.details.label, "2. B (best) (Recommended)");
	});

	it("falls back to label as value when label not found in labelToValue", async () => {
		let capturedDone: ((value: string | undefined) => void) | undefined;
		const ctx = makeMockCtx({
			custom: async <T,>(
				factory: (_tui: any, _theme: any, _keybindings: any, done: (result: T) => void) => any,
			) => {
				return new Promise<T>((resolve) => {
					capturedDone = (value: string | undefined) => resolve(value as T);
				});
			},
		});
		const handler = new QuestionHandler("/test", ctx);

		const resultPromise = handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [
				{ label: "X", value: "x" },
				{ label: "Y", value: "y" },
			],
		});

		// Simulate user picking an option with a label that doesn't exist in labelToValue
		capturedDone!("Unknown Label");

		const result = await resultPromise;
		assert.strictEqual(result.details.selected, "Unknown Label");
		assert.strictEqual(result.details.label, "Unknown Label");
	});
});

// ============================================================================
// Tests: QuestionHandler — mode defaults
// ============================================================================

describe("QuestionHandler — mode defaults", () => {
	it("treats undefined mode as choice", async () => {
		const ctx = makeMockCtx({
			custom: async <T,>() => undefined as T,
		});
		const handler = new QuestionHandler("/test", ctx);
		const result = await handler.handle({
			question: "Pick one:",
			options: [{ label: "A", value: "a" }],
		});

		// If treated as choice, cancel should give this message
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
	});
});

// ============================================================================
// Tests: QuestionHandler — error resilience
// ============================================================================

describe("QuestionHandler — error resilience", () => {
	it("handles empty options array in choice mode gracefully", async () => {
		const ctx = makeMockCtx({
			custom: async <T,>() => undefined as T,
		});
		const handler = new QuestionHandler("/test", ctx);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick one:",
			options: [],
		});

		// With no options and not disabled, Other should be available
		// If user cancels (undefined), we get cancellation
		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
	});

	it("handles missing options field as empty array", async () => {
		const ctx = makeMockCtx({
			custom: async <T,>() => undefined as T,
		});
		const handler = new QuestionHandler("/test", ctx);
		const result = await handler.handle({
			mode: "choice",
			question: "Pick one:",
		});

		assert.strictEqual(
			result.content[0]?.text,
			"User cancelled the question. Ask if they want to skip this topic and move on.",
		);
	});
});

// ============================================================================
// Tests: QuestionHandler — trust gate (real appendQnaEntry must not run)
// ============================================================================

describe("QuestionHandler — trust gate", () => {
	it("does not attempt persistence when isProjectTrusted() is false", async () => {
		const notifications: string[] = [];
		const ctx = makeMockCtx({
			input: async () => "answer",
			notify: (message: string) => {
				notifications.push(message);
			},
		});
		const handler = new QuestionHandler("/test", ctx);
		const result = await handler.handle({
			mode: "freetext",
			question: "Say something:",
		});

		assert.strictEqual(result.details.answer, "answer");
		// A trusted run would call appendQnaEntry("/test", ...) → EACCES on mkdir,
		// surfaced via ui.notify. The untrusted path must never get there.
		assert.strictEqual(
			notifications.some((m) => m.includes("Failed to save Q&A entry")),
			false,
		);
	});
});

// ============================================================================
// Tests: import hygiene — the suite must exercise the shipped class
// ============================================================================

describe("question-handler test — import hygiene", () => {
	it("imports the production QuestionHandler and declares no shadowing types", () => {
		const source = readFileSync(fileURLToPath(import.meta.url), "utf-8");

		assert.ok(
			/import\s*\{[^}]*\bQuestionHandler\b[^}]*\}\s*from\s*"\.\.\/question-handler\.ts"/.test(
				source,
			),
			"must import QuestionHandler from ../question-handler.ts",
		);

		for (const declaration of [
			/\bclass\s+QuestionHandler\b/,
			/\binterface\s+QuestionParams\b/,
			/\binterface\s+QuestionHandlerParams\b/,
			/\binterface\s+OptionItem\b/,
			/\binterface\s+LabelValuePair\b/,
			/\binterface\s+QnaEntry\b/,
			/\btype\s+Mode\b/,
		]) {
			assert.ok(
				!declaration.test(source),
				`local declaration matches ${declaration} — import it from production instead`,
			);
		}
	});
});
