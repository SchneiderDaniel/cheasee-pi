// ─── Tests: diagnostics.ts — pure diagnostic functions ────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	detectEventGap,
	type EventGap,
	buildErrorNotificationContext,
} from "../config/diagnostics.ts";

// ─── detectEventGap ─────────────────────────────────────────────

describe("detectEventGap", () => {
	interface Row {
		name: string;
		now: number;
		lastEventTime: number | undefined;
		thresholdMs: number;
		expected: EventGap;
	}

	const rows: Row[] = [
		{
			name: "undefined lastEventTime",
			now: 1000,
			lastEventTime: undefined,
			thresholdMs: 500,
			expected: { elapsedMs: 0, exceeded: false },
		},
		{
			name: "exact boundary (strict >)",
			now: 1000,
			lastEventTime: 500,
			thresholdMs: 500,
			expected: { elapsedMs: 500, exceeded: false },
		},
		{
			name: "sub-threshold",
			now: 1000,
			lastEventTime: 600,
			thresholdMs: 500,
			expected: { elapsedMs: 400, exceeded: false },
		},
		{
			name: "exceeds threshold",
			now: 1000,
			lastEventTime: 400,
			thresholdMs: 500,
			expected: { elapsedMs: 600, exceeded: true },
		},
		{
			name: "large elapsed",
			now: 10_000,
			lastEventTime: 1000,
			thresholdMs: 500,
			expected: { elapsedMs: 9000, exceeded: true },
		},
		{
			name: "negative elapsed (future timestamp)",
			now: 1000,
			lastEventTime: 2000,
			thresholdMs: 500,
			expected: { elapsedMs: -1000, exceeded: false },
		},
		{
			name: "zero threshold, elapsed > 0",
			now: 1000,
			lastEventTime: 999,
			thresholdMs: 0,
			expected: { elapsedMs: 1, exceeded: true },
		},
		{
			name: "zero threshold, elapsed === 0",
			now: 1000,
			lastEventTime: 1000,
			thresholdMs: 0,
			expected: { elapsedMs: 0, exceeded: false },
		},
	];

	for (const { name, now, lastEventTime, thresholdMs, expected } of rows) {
		it(name, () => {
			assert.deepEqual(detectEventGap(now, lastEventTime, thresholdMs), expected);
		});
	}
});

// ─── buildErrorNotificationContext ────────────────────────────────

describe("buildErrorNotificationContext", () => {
	it("includes event type and error message", () => {
		const event = { type: "tool_execution_start", toolName: "read" };
		const error = new Error("Something broke");
		const result = buildErrorNotificationContext(event, error);
		assert.ok(result.includes("tool_execution_start"));
		assert.ok(result.includes("Something broke"));
	});

	it("includes timestamp in HH:MM:SS format", () => {
		const event = { type: "message_update" };
		const error = new Error("test");
		const result = buildErrorNotificationContext(event, error);
		assert.ok(/\[\d{2}:\d{2}:\d{2}\]/.test(result));
	});

	it("handles string error", () => {
		const event = { type: "text_delta" };
		const result = buildErrorNotificationContext(event, "just a string");
		assert.ok(result.includes("text_delta"));
		assert.ok(result.includes("just a string"));
	});

	it("handles null event (no type)", () => {
		const error = new Error("null event");
		const result = buildErrorNotificationContext(null, error);
		assert.ok(result.includes("unknown"));
		assert.ok(result.includes("null event"));
	});

	it("handles non-object event", () => {
		const result = buildErrorNotificationContext("raw string", new Error("err"));
		assert.ok(result.includes("unknown"));
		assert.ok(result.includes("err"));
	});

	it("includes Event error prefix in context", () => {
		const event = { type: "thinking_delta" };
		const error = new Error("delta too large");
		const result = buildErrorNotificationContext(event, error);
		assert.ok(result.includes("Event error"));
		assert.ok(result.includes("thinking_delta"));
		assert.ok(result.includes("delta too large"));
	});
});
