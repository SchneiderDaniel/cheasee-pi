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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuestionHandler, type QuestionHandlerContext } from "../question-handler.ts";
import { makeMockCtx } from "./question-handler-harness.mts";

// Split from question-handler.test.mts (issue #2035 Long File refactor).

// ============================================================================
// Tests: QuestionHandler — mode defaults
// ============================================================================

describe("QuestionHandler — mode defaults", () => {
	it("treats undefined mode as choice (TUI dispatch)", async () => {
		let customCalled = false;
		const ctx = makeMockCtx({
			custom: async <T,>() => {
				customCalled = true;
				return undefined as T;
			},
		});
		const handler = new QuestionHandler("/test", ctx);
		const result = await handler.handle({
			question: "Pick one:",
			options: [{ label: "A", value: "a" }],
		});

		// The cancel text alone is identical for TUI choice and JSON cancel, so
		// assert the default "tui" dispatch actually reached ctx.ui.custom().
		assert.ok(
			customCalled,
			"undefined ctx.mode must default to the TUI choice path (ctx.ui.custom)",
		);
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
	it("does not persist when isProjectTrusted() is false", async () => {
		// Real, controlled project dir: with the gate removed this test would
		// write here (and the assertion below fails), rather than leaking a
		// file to a hardcoded path that a root run might silently write.
		const projectDir = mkdtempSync(join(tmpdir(), "ask-user-trust-gate-"));
		try {
			const notifications: string[] = [];
			const ctx = makeMockCtx({
				input: async () => "answer",
				notify: (message: string) => {
					notifications.push(message);
				},
			});
			const handler = new QuestionHandler(projectDir, ctx);
			const result = await handler.handle({
				mode: "freetext",
				question: "Say something:",
			});

			assert.strictEqual(result.details.answer, "answer");
			// Untrusted → logAnswer returns before appendQnaEntry, so no Q&A file
			// may exist. This is the direct persistence assertion the notification
			// check could not make.
			assert.strictEqual(
				existsSync(join(projectDir, ".pi", "context", "qna.jsonl")),
				false,
				"untrusted project must not have a qna.jsonl written",
			);
			assert.strictEqual(
				notifications.some((m) => m.includes("Failed to save Q&A entry")),
				false,
			);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// Tests: import hygiene — the suite must exercise the shipped class
// ============================================================================
