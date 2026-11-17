/**
 * Tests for context-info stream-estimate.ts — the streaming token estimate
 * (issue #2136).
 *
 * Why this module exists: the footer used to sample
 * `assistantMessageEvent.partial.usage.output`, which several providers only
 * populate once the response is complete. During streaming the value never
 * moved, so the TPS estimator had nothing to divide by time and the footer
 * showed `-- t/s` for the whole response.
 *
 * The estimate is content-derived: characters of streamed text, thinking and
 * tool-call arguments, divided by 4 characters-per-token and rounded up. It is
 * an approximation — the footer marks it with `~` — but it grows monotonically
 * within a response, which is all the rolling-rate estimator needs.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/stream-estimate.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import { estimateStreamedTokens } from "../stream-estimate.ts";

/** Minimal assistant message shape: only `content` matters to the estimator. */
function makeAssistantMessage(content: unknown[], extra: Record<string, unknown> = {}) {
	return { role: "assistant", content, usage: { output: 0 }, ...extra } as never;
}

const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value });
const toolCall = (args: Record<string, unknown>) => ({
	type: "toolCall",
	id: "call-1",
	name: "read",
	arguments: args,
});

describe("estimateStreamedTokens — content shapes", () => {
	it("empty content → 0", () => {
		assert.strictEqual(estimateStreamedTokens(makeAssistantMessage([])), 0);
	});

	it("one text block: ceil(chars / 4)", () => {
		assert.strictEqual(estimateStreamedTokens(makeAssistantMessage([text("abcdefgh")])), 2);
		assert.strictEqual(estimateStreamedTokens(makeAssistantMessage([text("abcdefghi")])), 3);
	});

	it("text and thinking characters are summed before the division", () => {
		// 8 + 4 = 12 chars → 3 tokens (one division, not two ceilings)
		assert.strictEqual(
			estimateStreamedTokens(makeAssistantMessage([text("abcdefgh"), thinking("wxyz")])),
			3,
		);
	});

	it("tool-call arguments count as their JSON encoding", () => {
		// {"path":"a.txt"} = 16 chars → 4 tokens
		assert.strictEqual(
			estimateStreamedTokens(makeAssistantMessage([toolCall({ path: "a.txt" })])),
			4,
		);
	});

	it("text + thinking + tool call sum: 8 + 4 + 16 = 28 chars → 7", () => {
		assert.strictEqual(
			estimateStreamedTokens(
				makeAssistantMessage([text("abcdefgh"), thinking("wxyz"), toolCall({ path: "a.txt" })]),
			),
			7,
		);
	});
});

describe("estimateStreamedTokens — ignores provider usage", () => {
	it("usage.output === 0 with streamed text still yields a positive estimate", () => {
		// This is the reported bug: the provider withholds incremental output
		// usage, so any usage-derived sample stays 0.
		const message = makeAssistantMessage([text("hello world, this is a streamed reply")], {
			usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
		});
		assert.strictEqual((message as any).usage.output, 0, "fixture sanity: provider reports 0");
		assert.ok(estimateStreamedTokens(message) > 0, "estimate must not read usage");
	});

	it("changing usage.output does not change the estimate", () => {
		const content = [text("abcdefgh")];
		const withZero = makeAssistantMessage(content, { usage: { output: 0 } });
		const withMany = makeAssistantMessage(content, { usage: { output: 9000 } });
		assert.strictEqual(estimateStreamedTokens(withZero), estimateStreamedTokens(withMany));
	});
});

describe("estimateStreamedTokens — malformed input is tolerated", () => {
	it("text block missing `text` → 0", () => {
		assert.strictEqual(estimateStreamedTokens(makeAssistantMessage([{ type: "text" }])), 0);
	});

	it("null entries → 0 without throwing", () => {
		assert.strictEqual(estimateStreamedTokens(makeAssistantMessage([null])), 0);
		assert.strictEqual(estimateStreamedTokens(makeAssistantMessage([null, null])), 0);
	});

	it("missing content, missing message, undefined, null → 0", () => {
		assert.strictEqual(estimateStreamedTokens({ role: "assistant" } as never), 0);
		assert.strictEqual(estimateStreamedTokens(undefined), 0);
		assert.strictEqual(estimateStreamedTokens(null), 0);
	});

	it("unserializable tool arguments do not throw", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		assert.strictEqual(
			estimateStreamedTokens(makeAssistantMessage([toolCall(circular)])),
			0,
			"circular arguments contribute 0 characters instead of throwing",
		);
	});
});

describe("estimateStreamedTokens — monotonic within a response", () => {
	it("a longer stream never estimates fewer tokens", () => {
		const short = estimateStreamedTokens(makeAssistantMessage([text("aaaa")]));
		const long = estimateStreamedTokens(makeAssistantMessage([text("aaaaaaaa")]));
		assert.ok(long >= short, `expected ${long} >= ${short}`);
		assert.ok(short > 0);
	});
});
