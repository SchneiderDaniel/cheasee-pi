/**
 * Entity tests for .pi/extensions/lib/safe-argv.ts — the argv-safety invariant
 * shared by the CodeFlow-flagged spawn sites.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/test/safe-argv.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { argvCommand, assertNoShell, assertSafeEnv, spawnArgv, UnsafeArgvError } from "../safe-argv.ts";

describe("argvCommand", () => {
	it("returns program and args unchanged, order preserved", () => {
		const { program, args } = argvCommand("git", ["--git-dir", "/x/.bare", "config"]);
		assert.strictEqual(program, "git");
		assert.deepStrictEqual(args, ["--git-dir", "/x/.bare", "config"]);
	});

	it("returns a frozen copy — mutating the caller's array after the call is inert", () => {
		const input = ["a", "b"];
		const command = argvCommand("git", input);
		assert.ok(Object.isFrozen(command));
		assert.ok(Object.isFrozen(command.args));
		input.push("c");
		assert.deepStrictEqual(command.args, ["a", "b"], "result must not alias the input array");
	});

	it("accepts literal absolute programs and args with spaces, '-', '=', '--', unicode and paths", () => {
		const { args } = argvCommand("/usr/bin/pi", [
			"some task with spaces",
			"-",
			"--flag=value",
			"--",
			"ünïcode-✅",
			"/tmp/a b/c.ts",
		]);
		assert.strictEqual(args.length, 6);
	});

	it("throws UnsafeArgvError for an empty program, naming the field", () => {
		assert.throws(
			() => argvCommand("", []),
			(err: unknown) =>
				err instanceof UnsafeArgvError && err.code === "UNSAFE_ARGV" && /program/.test(err.message),
		);
	});

	it("throws for a whitespace-only program", () => {
		assert.throws(() => argvCommand("   ", []), UnsafeArgvError);
	});

	it("throws for a program starting with '-' (option injection)", () => {
		assert.throws(() => argvCommand("-a", []), UnsafeArgvError);
	});

	it("throws for NUL in the program or in any arg", () => {
		assert.throws(() => argvCommand("gi\0t", []), UnsafeArgvError);
		assert.throws(() => argvCommand("/usr/bin/pi", ["ok", "bad\0arg"]), UnsafeArgvError);
	});

	it("accepts newlines and tabs in args (only NUL is rejected)", () => {
		const task = "line one\nline two\tindented";
		const systemPrompt = "You are pi.\n\nRules:\n1. ...";
		const { program, args } = argvCommand("/usr/bin/pi", [
			"-p",
			"--mode",
			"json",
			task,
			"--system-prompt",
			systemPrompt,
		]);
		assert.strictEqual(program, "/usr/bin/pi");
		assert.deepStrictEqual(args.slice(3, 4), [task]);
		assert.deepStrictEqual(args.slice(5, 6), [systemPrompt]);
	});

	it("rejects an interpreter that would run argv code (`node -e`, `python -c`) — executable-aware", () => {
		assert.throws(() => argvCommand("node", ["-e", "console.log(1)"]), UnsafeArgvError);
		assert.throws(() => argvCommand("/usr/bin/node", ["--eval=1+1"]), UnsafeArgvError);
		assert.throws(() => argvCommand("python3", ["-c", "print(1)"]), UnsafeArgvError);
		assert.throws(() => argvCommand("perl", ["-e", "1"]), UnsafeArgvError);
	});

	it("accepts an interpreter invocation without a code flag (positive control)", () => {
		assert.doesNotThrow(() => argvCommand("node", ["server.js", "--stdio"]));
		assert.doesNotThrow(() => argvCommand("python3", ["-m", "http.server"]));
		// A `-e`-looking arg on a non-interpreter program is not an eval flag.
		assert.doesNotThrow(() => argvCommand("git", ["-e"]));
	});
});

describe("assertNoShell", () => {
	it("forces shell:false and preserves cwd, env and unrelated keys", () => {
		const options = { cwd: "/tmp", env: { A: "1" }, detached: true };
		const result = assertNoShell(options);
		assert.strictEqual(result.shell, false);
		assert.strictEqual(result.cwd, "/tmp");
		assert.deepStrictEqual(result.env, { A: "1" });
		assert.strictEqual(result.detached, true);
	});

	it("throws for shell:true and shell:'/bin/bash' (positive control)", () => {
		assert.throws(() => assertNoShell({ shell: true }), UnsafeArgvError);
		assert.throws(() => assertNoShell({ shell: "/bin/bash" }), UnsafeArgvError);
	});

	it("does not mutate its input object", () => {
		const options = { cwd: "/tmp" };
		assertNoShell(options);
		assert.deepStrictEqual(options, { cwd: "/tmp" });
	});

	it("accepts undefined (no options)", () => {
		assert.deepStrictEqual(assertNoShell(undefined), { shell: false });
	});
});

describe("spawnArgv", () => {
	it("validates the argv and forces shell:false before calling the spawn fn", () => {
		const calls: Array<[string, readonly string[], object]> = [];
		const spawnFn = (program: string, args: readonly string[], options?: object) => {
			calls.push([program, args, options ?? {}]);
			return "child";
		};
		const result = spawnArgv(spawnFn, "/usr/bin/pi", ["--version"], { cwd: "/tmp" });
		assert.strictEqual(result, "child");
		assert.deepStrictEqual(calls, [["/usr/bin/pi", ["--version"], { cwd: "/tmp", shell: false }]]);
	});

	it("throws before calling the spawn fn on NUL argv or a requested shell", () => {
		let called = false;
		const spawnFn = () => {
			called = true;
			return "child";
		};
		assert.throws(() => spawnArgv(spawnFn, "/usr/bin/pi", ["bad\0arg"]), UnsafeArgvError);
		assert.throws(() => spawnArgv(spawnFn, "-a", []), UnsafeArgvError);
		assert.throws(() => spawnArgv(spawnFn, "/usr/bin/pi", [], { shell: true }), UnsafeArgvError);
		assert.strictEqual(called, false, "the spawn fn must never run on invalid argv");
	});
});

describe("assertSafeEnv", () => {
	it("passes a valid env through", () => {
		const env = { PATH: "/usr/bin", PI_NO_COLOR: "1" };
		assert.strictEqual(assertSafeEnv(env), env);
	});

	it("accepts newlines and tabs in env values (multiline credentials)", () => {
		const env = { PEM: "-----BEGIN KEY-----\nMIIB\t...\n-----END KEY-----\n" };
		assert.strictEqual(assertSafeEnv(env), env);
	});

	it("throws for a NUL in an env value or key", () => {
		assert.throws(() => assertSafeEnv({ A: "x\0y" }), UnsafeArgvError);
		assert.throws(() => assertSafeEnv({ "A\0": "x" }), UnsafeArgvError);
	});
});
