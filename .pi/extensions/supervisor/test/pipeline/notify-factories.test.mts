// ─── Tests: pipeline/helpers.ts — NotifyFn factories ─────────────
// nullNotify() and toNotifyFn() are the single homes of the info/error
// NotifyFn literals. No pi types are needed to build a target.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nullNotify, toNotifyFn, type NotifyFn } from "../../pipeline/helpers.ts";

describe("nullNotify()", () => {
	it("returns no-op info/error that never throw", () => {
		const notify: NotifyFn = nullNotify();
		assert.equal(notify.info("hello"), undefined);
		assert.equal(notify.error("boom"), undefined);
	});
});

describe("toNotifyFn()", () => {
	it("routes info/error to target.notify when hasUI is true", () => {
		const calls: Array<{ msg: string; level: string }> = [];
		const notify = toNotifyFn({
			hasUI: true,
			notify: (msg, level) => calls.push({ msg, level }),
		});
		notify.info("i");
		notify.error("e");
		assert.deepEqual(calls, [
			{ msg: "i", level: "info" },
			{ msg: "e", level: "error" },
		]);
	});

	it("calls notify zero times and does not throw when hasUI is false", () => {
		let calls = 0;
		const notify = toNotifyFn({
			hasUI: false,
			notify: () => {
				calls++;
			},
		});
		notify.info("i");
		notify.error("e");
		assert.equal(calls, 0);
	});

	it("accepts a structural NotifyTarget without a pi import", () => {
		// The target here is a plain object literal — proof the factory is
		// decoupled from ExtensionContext.
		const target = {
			hasUI: true,
			notify: (_msg: string, _level: "info" | "error") => {},
		};
		assert.equal(typeof toNotifyFn(target).info, "function");
	});
});
