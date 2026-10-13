/**
 * Tests for .pi/extensions/rtk/test/harness.ts — the shared harness for the rtk
 * version-gate suites.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/rtk/test/harness.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	captureWarnings,
	deferred,
	fireBash,
	fireSessionStart,
	killedProbe,
	makePi,
	ok,
	fail,
	restoreWarnings,
	warnText,
	warnings,
} from "./harness.ts";

describe("rtk harness — ExecResult factories", () => {
	it("ok/fail/killedProbe return the exact shapes", () => {
		assert.deepEqual(ok("v"), { stdout: "v", stderr: "", code: 0, killed: false });
		assert.deepEqual(fail(3, "o", "e"), { stdout: "o", stderr: "e", code: 3, killed: false });
		assert.deepEqual(killedProbe(), { stdout: "", stderr: "", code: null, killed: true });
	});
});

describe("rtk harness — makePi", () => {
	it("records exec(cmd,args,opts) and returns the impl's result", async () => {
		const seen: unknown[] = [];
		const f = makePi(async (cmd, args, opts) => {
			seen.push([cmd, args, opts]);
			return ok("out");
		});
		const result = await f.pi.exec("rtk", ["--version"], { timeout: 500 });
		assert.equal(result.stdout, "out");
		assert.deepEqual(f.calls, [{ cmd: "rtk", args: ["--version"], opts: { timeout: 500 } }]);
		assert.deepEqual(seen, [["rtk", ["--version"], { timeout: 500 }]]);
	});

	it("registers handlers by event name", () => {
		const f = makePi(async () => ok(""));
		const h1 = () => {};
		const h2 = () => {};
		f.pi.on("session_start", h1);
		f.pi.on("session_start", h2);
		f.pi.on("tool_call", h1);
		assert.equal(f.handlers.get("session_start")?.length, 2);
		assert.equal(f.handlers.get("tool_call")?.length, 1);
	});
});

describe("rtk harness — dispatchers", () => {
	it("fireSessionStart invokes every session_start handler once", async () => {
		const f = makePi(async () => ok(""));
		let a = 0;
		let b = 0;
		f.pi.on("session_start", () => {
			a++;
		});
		f.pi.on("session_start", () => {
			b++;
		});
		await fireSessionStart(f);
		assert.equal(a, 1);
		assert.equal(b, 1);
	});

	it("fireBash dispatches to tool_call handlers and returns the event", async () => {
		const f = makePi(async () => ok(""));
		let calls = 0;
		f.pi.on("tool_call", (event: any) => {
			calls++;
			event.input.command = "rewritten";
		});
		const event = await fireBash(f, "git status");
		assert.equal(calls, 1);
		assert.equal(event.input.command, "rewritten");
	});
});

describe("rtk harness — warnings capture", () => {
	afterEach(() => restoreWarnings());

	it("captures during and restores the original console.warn after", () => {
		const original = console.warn;
		captureWarnings();
		console.warn("boom", 1);
		assert.equal(warnings.length, 1);
		assert.match(warnText(), /boom 1/);
		restoreWarnings();
		assert.equal(console.warn, original, "the original warn is restored");
	});

	it("resets the buffer on each capture", () => {
		captureWarnings();
		console.warn("first");
		captureWarnings();
		console.warn("second");
		assert.equal(warnings.length, 1);
		assert.match(warnText(), /second/);
	});
});

describe("rtk harness — deferred", () => {
	it("exposes a promise settled by resolve", async () => {
		const d = deferred<number>();
		d.resolve(42);
		assert.equal(await d.promise, 42);
	});
});
