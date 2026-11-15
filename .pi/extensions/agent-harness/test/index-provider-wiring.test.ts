/**
 * AgentHarness — tool-info provider wiring at the adapter edge (issue #2093).
 *
 * The extension builds the `pi.getAllTools()` port once at init and hands it to
 * the `AgentHarness` constructor. Split out of `index-dispatch.test.ts`
 * (issue #2005 long-file ceiling) when the construction-time injection cases
 * were added.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import agentHarness from "../index.ts";
import { createMockAPI, makeConfigCtx } from "./harness-fixtures.ts";

describe("AgentHarness — tool-info provider wiring (adapter)", () => {
	it("provider built at extension init — annotations work without session_start", async () => {
		let calls = 0;
		const api = createMockAPI({
			getAllTools: () => {
				calls++;
				return [{ name: "read", annotations: { readOnlyHint: true } }];
			},
		});
		agentHarness(api);
		await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "a.ts" }, isError: true },
			makeConfigCtx(),
		);
		await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "b.ts" }, isError: true },
			makeConfigCtx(),
		);
		const r = await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "c.ts" } },
			makeConfigCtx(),
		);
		assert.equal(r, undefined, "third read passes — no session_start was fired");
		assert.ok(calls >= 1, "provider consulted lazily on tool_call, no eager snapshot");
	});

	it("feature-detect: pi.getAllTools missing → no throw, legacy behaviour", async () => {
		const api = createMockAPI();
		delete (api as any).getAllTools;
		agentHarness(api);
		const results = [];
		for (let i = 0; i < 8; i++) {
			results.push(
				await api.fire(
					"tool_call",
					{ toolName: "write", input: { path: "f.ts", content: "" } },
					makeConfigCtx(),
				),
			);
		}
		assert.ok(results[7]?.block, "default threshold still applies");
	});

	it("getAllTools returning a non-array yields an empty provider", async () => {
		const api = createMockAPI({ getAllTools: () => undefined });
		agentHarness(api);
		const r = await api.fire(
			"tool_call",
			{ toolName: "write", input: { path: "f.ts", content: "" } },
			makeConfigCtx(),
		);
		assert.equal(r, undefined, "no throw — default meta applies");
	});

	it("throwing getAllTools → fail-open, one warning across sessions", async () => {
		const errors: unknown[][] = [];
		const originalError = console.error;
		console.error = (...a: unknown[]) => {
			errors.push(a);
		};
		try {
			const api = createMockAPI({
				getAllTools: () => {
					throw new Error("tools boom");
				},
			});
			agentHarness(api);
			assert.equal(
				await api.fire("tool_call", { toolName: "mystery", input: {} }, makeConfigCtx()),
				undefined,
				"throwing port never becomes a block",
			);
			await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());
			assert.equal(
				await api.fire("tool_call", { toolName: "mystery", input: {} }, makeConfigCtx()),
				undefined,
				"still fail-open after session_start",
			);
		} finally {
			console.error = originalError;
		}
		assert.equal(errors.length, 1, "exactly one warning for the extension's lifetime");
		assert.ok(String(errors[0][0]).includes("tools boom"));
	});

	it("no snapshot at init — tools registered later are visible", async () => {
		const tools: Array<{ name: string; annotations?: Record<string, boolean> }> = [];
		const api = createMockAPI({ getAllTools: () => tools });
		agentHarness(api);
		tools.push({ name: "read", annotations: { readOnlyHint: true } });
		await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "a.ts" }, isError: true },
			makeConfigCtx(),
		);
		await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "b.ts" }, isError: true },
			makeConfigCtx(),
		);
		const r = await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "c.ts" } },
			makeConfigCtx(),
		);
		assert.equal(r, undefined, "later-registered read-only tool is honoured");
	});

	it("session_start still resets harness state", async () => {
		const api = createMockAPI();
		agentHarness(api);
		for (let i = 0; i < 9; i++) {
			const result = await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: `f${i}.ts`, content: "" } },
				makeConfigCtx(),
			);
			if (i >= 7) assert.ok(result?.block, `call ${i} blocked`);
			else assert.equal(result, undefined, `call ${i} passes`);
		}
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());
		assert.equal(
			await api.fire(
				"tool_call",
				{ toolName: "write", input: { path: "fresh.ts", content: "" } },
				makeConfigCtx(),
			),
			undefined,
			"fresh state after session_start",
		);
	});

	it("session_start does not re-inject — annotation behaviour is unchanged", async () => {
		const api = createMockAPI({
			getAllTools: () => [{ name: "read", annotations: { readOnlyHint: true } }],
		});
		agentHarness(api);
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());
		await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "a.ts" }, isError: true },
			makeConfigCtx(),
		);
		await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "b.ts" }, isError: true },
			makeConfigCtx(),
		);
		const r = await api.fire(
			"tool_call",
			{ toolName: "read", input: { path: "c.ts" } },
			makeConfigCtx(),
		);
		assert.equal(r, undefined, "same read-only behaviour with or without session_start");
	});

	it("nested calls flow through dispatch with parentToolCallId", async () => {
		const api = createMockAPI();
		agentHarness(api);
		await api.fire("session_start", { type: "session_start", reason: "new" }, makeConfigCtx());
		await api.fire(
			"tool_call",
			{ toolName: "write", input: { path: "a.ts", content: "" }, toolCallId: "p1" },
			makeConfigCtx(),
		);
		await api.fire(
			"tool_call",
			{ toolName: "read", input: {}, isError: true, toolCallId: "p1/1", parentToolCallId: "p1" },
			makeConfigCtx(),
		);
		await api.fire(
			"tool_call",
			{ toolName: "read", input: {}, isError: true, toolCallId: "p1/2", parentToolCallId: "p1" },
			makeConfigCtx(),
		);
		const r = await api.fire(
			"tool_call",
			{ toolName: "write", input: { path: "b.ts", content: "" } },
			makeConfigCtx(),
		);
		assert.ok(r?.block, "parent write blocked by rolled-up nested errors");
	});
});
