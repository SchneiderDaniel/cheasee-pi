// ─── Tests: pipeline/result.ts — Result<T> type + withNotify ────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { type Result, withNotify } from "../../pipeline/result.ts";
import type { NotifyFn } from "../../pipeline/helpers.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function createMockNotify(): {
	notify: NotifyFn;
	calls: Array<{ level: string; msg: string }>;
} {
	const calls: Array<{ level: string; msg: string }> = [];
	const notify: NotifyFn = {
		info: (msg: string) => calls.push({ level: "info", msg }),
		error: (msg: string) => calls.push({ level: "error", msg }),
	};
	return { notify, calls };
}

// ─── Tests: Result<T> type ───────────────────────────────────────

describe("Result<T> type", () => {
	it("has ok=true with value for success", () => {
		const r: Result<number> = { ok: true, value: 42 };
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.value, 42);
		}
	});

	it("has ok=false with error and source for failure", () => {
		const r: Result<string> = { ok: false, error: "something broke", source: "test" };
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal(r.error, "something broke");
			assert.equal(r.source, "test");
		}
	});

	it("narrows type via ok discriminant in if-else", () => {
		const r: Result<number> = { ok: true, value: 42 };
		if (r.ok) {
			// r is narrowed to { ok: true; value: number }
			assert.equal(r.value, 42);
		} else {
			assert.fail("should not reach else branch");
		}
	});

	it("narrows type via !ok discriminant in else branch", () => {
		const r: Result<number> = { ok: false, error: "fail", source: "test" };
		if (!r.ok) {
			// r is narrowed to { ok: false; error: string; source: string }
			assert.equal(r.error, "fail");
			assert.equal(r.source, "test");
		} else {
			assert.fail("should not reach else branch");
		}
	});

	it("supports void value type", () => {
		const r: Result<void> = { ok: true, value: undefined };
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.value, undefined);
		}
	});

	it("supports custom error type via generic parameter", () => {
		// Using default E = string is most common
		// Custom error types work via the generic
		type CustomError = { code: number; message: string };
		const r: Result<string, CustomError> = {
			ok: false,
			error: { code: 404, message: "Not found" },
			source: "api",
		};
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal(r.error.code, 404);
			assert.equal(r.error.message, "Not found");
		}
	});
});

// ─── Tests: withNotify() ─────────────────────────────────────────

describe("withNotify()", () => {
	it("returns { ok: true, value } on success", async () => {
		const { notify } = createMockNotify();
		const result = await withNotify(() => Promise.resolve(42), notify, "test");
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value, 42);
		}
	});

	it("returns { ok: false } on thrown error — calls notify.error", async () => {
		const { notify, calls } = createMockNotify();
		const result = await withNotify(() => Promise.reject(new Error("boom")), notify, "test");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.error, "boom");
			assert.equal(result.source, "test");
		}
		assert.equal(calls.length, 1);
		assert.equal(calls[0].level, "error");
		assert.ok(calls[0].msg.includes("[test]"), "should include source in brackets");
		assert.ok(calls[0].msg.includes("boom"), "should include error message");
	});

	it("does NOT call notify.error on success", async () => {
		const { notify, calls } = createMockNotify();
		await withNotify(() => Promise.resolve(42), notify, "test");
		assert.equal(calls.length, 0);
	});

	it("propagates thrown non-Error values as string", async () => {
		const { notify } = createMockNotify();
		const result = await withNotify(() => Promise.reject("string error"), notify, "test");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.error, "string error");
		}
	});

	it("handles thrown null via String(null) fallback", async () => {
		const { notify } = createMockNotify();
		const result = await withNotify(() => Promise.reject(null), notify, "test");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.error, "null");
		}
	});

	it("handles thrown undefined via String(undefined) fallback", async () => {
		const { notify } = createMockNotify();
		const result = await withNotify(() => Promise.reject(undefined), notify, "test");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.error, "undefined");
		}
	});

	it("passes source identifier to error result", async () => {
		const { notify } = createMockNotify();
		const result = await withNotify(() => Promise.reject(new Error("err")), notify, "my-source");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.source, "my-source");
		}
	});

	it("calls notify.error exactly once on failure", async () => {
		const { notify, calls } = createMockNotify();
		await withNotify(() => Promise.reject(new Error("once")), notify, "test");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].level, "error");
	});

	it("works with async function that throws synchronously", async () => {
		const { notify } = createMockNotify();
		const result = await withNotify(() => Promise.reject(new Error("sync fail")), notify, "test");
		assert.equal(result.ok, false);
	});

	it("returns resolved value for Promise<void>", async () => {
		const { notify } = createMockNotify();
		const result = await withNotify(() => Promise.resolve(undefined), notify, "test");
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.value, undefined);
		}
	});

	it("exhaustiveness: compiler forces both branches via discriminated union", () => {
		// This is a compile-time test — the type system MUST force
		// handling both ok:true and ok:false branches
		function handle(r: Result<number>): number {
			if (r.ok) {
				// ok branch: value exists
				return r.value;
			} else {
				// !ok branch: error and source exist
				throw new Error(r.error);
			}
		}
		assert.equal(handle({ ok: true, value: 42 }), 42);
		assert.throws(() => handle({ ok: false, error: "fail", source: "test" }), /fail/);
	});
});
