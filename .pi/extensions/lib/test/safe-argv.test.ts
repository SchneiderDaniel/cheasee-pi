/**
 * Entity tests for .pi/extensions/lib/safe-argv.ts — the argv-safety invariant
 * shared by the CodeFlow-flagged spawn sites.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/test/safe-argv.test.ts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	argvCommand,
	assertNoShell,
	assertSafeEnv,
	sanitizeSpawnEnv,
	spawnArgv,
	UnsafeArgvError,
} from "../safe-argv.ts";

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

	it("rejects an interpreter's module-loading flags (`--require`, `--import`, `--loader`, `-m`)", () => {
		// Each loads and runs attacker-named code without a shell.
		assert.throws(() => argvCommand("node", ["--require", "./hook.cjs"]), UnsafeArgvError);
		assert.throws(() => argvCommand("node", ["-r", "./hook.cjs"]), UnsafeArgvError);
		assert.throws(() => argvCommand("node", ["--import", "./hook.mjs"]), UnsafeArgvError);
		assert.throws(() => argvCommand("node", ["--loader", "./hook.mjs"]), UnsafeArgvError);
		assert.throws(
			() => argvCommand("node", ["--experimental-loader", "./hook.mjs"]),
			UnsafeArgvError,
		);
		assert.throws(() => argvCommand("python3", ["-m", "attacker_module"]), UnsafeArgvError);
	});

	it("rejects an interpreter's attached module-loading flags (`-Mmodule`, `-mmodule`, `-ecode`) — regression", () => {
		// Perl attaches the module name to the flag; `-MAttacker` runs its init code.
		assert.throws(() => argvCommand("perl", ["-I/tmp/attacker", "-MAttacker"]), UnsafeArgvError);
		assert.throws(() => argvCommand("perl", ["-MAttacker"]), UnsafeArgvError);
		assert.throws(() => argvCommand("python3", ["-mattacker_module"]), UnsafeArgvError);
		assert.throws(() => argvCommand("ruby", ["-r./hook.rb"]), UnsafeArgvError);
		// Positive control: `-I` only extends the module search path, it runs nothing.
		assert.doesNotThrow(() => argvCommand("perl", ["-I/tmp/lib", "script.pl"]));
	});

	it("rejects an interpreter's attached and combined code flags (`-cprint(1)`, `-lc`) — regression", () => {
		// The audit probe: Python attaches the program to `-c`, and a shell combines
		// `-l`/`-c`. Both run argv code, so both must be rejected.
		assert.throws(() => argvCommand("python3", ["-cprint(1)"]), UnsafeArgvError);
		assert.throws(() => argvCommand("python3", ["-c=print(1)"]), UnsafeArgvError);
		assert.throws(() => argvCommand("sh", ["-cecho pwned"]), UnsafeArgvError);
		assert.throws(() => argvCommand("bash", ["-lc", "id"]), UnsafeArgvError);
		assert.throws(() => argvCommand("/bin/bash", ["-lcid"]), UnsafeArgvError);
		// Positive control: an attached *path* flag (`-I`) runs nothing.
		assert.doesNotThrow(() => argvCommand("perl", ["-I/tmp/lib", "script.pl"]));
	});

	it("accepts an interpreter invocation without a code flag (positive control)", () => {
		assert.doesNotThrow(() => argvCommand("node", ["server.js", "--stdio"]));
		assert.doesNotThrow(() => argvCommand("python3", ["server.py", "--port", "8080"]));
		assert.doesNotThrow(() => argvCommand("bash", ["script.sh", "--port", "8080"]));
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

// ─── spawnArgv owns the env policy ────────────────────────────────
// `safe-argv.ts` already declares env an execution channel (NODE_OPTIONS,
// LD_PRELOAD, GIT_CONFIG_*, …). A spawn seam that forwards a caller's env
// without dropping those is not argv-safe, so the policy lives in the one
// seam every caller already passes through — not in each adapter.

describe("spawnArgv — env policy", () => {
	type Received = { options: Record<string, unknown> };

	const capture = (): { spawnFn: (...a: any[]) => unknown; received: Received[] } => {
		const received: Received[] = [];
		const spawnFn = (_program: string, _args: readonly string[], options: object = {}) => {
			received.push({ options: options as Record<string, unknown> });
			return "child";
		};
		return { spawnFn: spawnFn as (...a: any[]) => unknown, received };
	};

	it("drops every env execution channel, keeps the harmless variables", () => {
		const { spawnFn, received } = capture();
		spawnArgv(spawnFn, "/usr/bin/git", ["status"], {
			env: {
				NODE_OPTIONS: "--require /tmp/hook.cjs",
				LD_PRELOAD: "/tmp/lib.so",
				BASH_ENV: "/tmp/hook.sh",
				GIT_SSH_COMMAND: "sh -c id",
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "core.sshCommand",
				PATH: "/usr/bin",
				HOME: "/home/a",
			},
		});

		assert.strictEqual(received.length, 1);
		assert.deepStrictEqual(received[0]!.options.env, { PATH: "/usr/bin", HOME: "/home/a" });
		assert.strictEqual(received[0]!.options.shell, false);
	});

	it("synthesizes no env for a caller that passes none", () => {
		const { spawnFn, received } = capture();
		spawnArgv(spawnFn, "/usr/bin/git", ["status"], { cwd: "/tmp" });

		assert.strictEqual(received.length, 1);
		assert.strictEqual("env" in received[0]!.options, false, "no env key may be invented");
		assert.strictEqual(received[0]!.options.cwd, "/tmp");
	});

	it("keeps an empty env an empty object (not undefined)", () => {
		const { spawnFn, received } = capture();
		spawnArgv(spawnFn, "/usr/bin/git", ["status"], { env: {} });

		assert.deepStrictEqual(received[0]!.options.env, {});
		assert.strictEqual("env" in received[0]!.options, true);
	});

	it("mutates no caller object — options stay untouched, env stays unrewritten", () => {
		const env = { PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/hook.cjs" };
		const options = { cwd: "/tmp", env };
		const { spawnFn } = capture();

		spawnArgv(spawnFn, "/usr/bin/git", ["status"], options);

		assert.deepStrictEqual(env, {
			PATH: "/usr/bin",
			NODE_OPTIONS: "--require /tmp/hook.cjs",
		});
		assert.strictEqual(options.env, env, "the caller's env object must not be swapped out");
		assert.deepStrictEqual(Object.keys(options), ["cwd", "env"], "no keys rewritten");
	});

	it("drops undefined env values so no non-string entry reaches spawn", () => {
		const { spawnFn, received } = capture();
		spawnArgv(spawnFn, "/usr/bin/git", ["status"], { env: { A: undefined, B: "b" } });

		assert.deepStrictEqual(received[0]!.options.env, { B: "b" });
	});

	it("throws for a NUL in an env value, spawn never runs", () => {
		const { spawnFn, received } = capture();
		assert.throws(
			() => spawnArgv(spawnFn, "/usr/bin/git", ["status"], { env: { A: "x\0y" } }),
			UnsafeArgvError,
		);
		assert.strictEqual(received.length, 0, "the spawn fn must never run on a malformed env");
	});

	it("throws for env plus a requested shell, spawn never runs", () => {
		const { spawnFn, received } = capture();
		assert.throws(
			() => spawnArgv(spawnFn, "/usr/bin/git", ["status"], { env: { A: "1" }, shell: true }),
			UnsafeArgvError,
		);
		assert.strictEqual(received.length, 0);
	});

	it("validates the argv first — a NUL arg throws, spawn never runs", () => {
		const { spawnFn, received } = capture();
		assert.throws(
			() => spawnArgv(spawnFn, "/usr/bin/git", ["bad\0arg"], { env: { A: "1" } }),
			UnsafeArgvError,
		);
		assert.strictEqual(received.length, 0);
	});

	it("passes the spawn fn's return value through unchanged", () => {
		const child = { pid: 4242 };
		const result = spawnArgv(() => child, "/usr/bin/git", ["status"], { env: { A: "1" } });
		assert.strictEqual(result, child);
	});

	it("keeps env policy out of assertNoShell (that primitive owns the shell)", () => {
		const env = { NODE_OPTIONS: "--require /tmp/h.cjs" };
		const result = assertNoShell({ env });
		assert.deepStrictEqual(result.env, env, "assertNoShell must not sanitize");
		assert.strictEqual(result.shell, false);
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

describe("sanitizeSpawnEnv", () => {
	// Every key here lets the environment run code the argv never shows, so a
	// spawn that forwards them is not argv-safe.
	const EXECUTION_CHANNELS: Record<string, string> = {
		NODE_OPTIONS: "--require /tmp/hook.cjs",
		NODE_PATH: "/tmp/modules",
		LD_PRELOAD: "/tmp/lib.so",
		LD_AUDIT: "/tmp/audit.so",
		DYLD_INSERT_LIBRARIES: "/tmp/lib.dylib",
		BASH_ENV: "/tmp/hook.sh",
		ENV: "/tmp/hook.sh",
		PS4: "$(id)",
		PERL5OPT: "-Mstrict",
		RUBYOPT: "-r/tmp/hook.rb",
		PYTHONSTARTUP: "/tmp/hook.py",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.sshCommand",
		GIT_CONFIG_VALUE_0: "sh -c id",
		GIT_SSH_COMMAND: "sh -c id",
		GIT_EXTERNAL_DIFF: "sh -c id",
		GCONV_PATH: "/tmp",
	};

	it("drops every execution-capable variable and keeps the rest", () => {
		const kept = { PATH: "/usr/bin", HOME: "/home/a", PI_NO_COLOR: "1" };
		assert.deepStrictEqual(sanitizeSpawnEnv({ ...EXECUTION_CHANNELS, ...kept }), kept);
	});

	it("drops undefined values so spawn never receives a non-string entry", () => {
		const env = sanitizeSpawnEnv({ A: undefined, B: "b" });
		assert.deepStrictEqual(env, { B: "b" });
	});

	it("does not mutate its input", () => {
		const input = { PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/hook.cjs" };
		sanitizeSpawnEnv(input);
		assert.deepStrictEqual(input, { PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/hook.cjs" });
	});

	it("throws for a NUL in an env key or value (fail closed)", () => {
		assert.throws(() => sanitizeSpawnEnv({ A: "x\0y" }), UnsafeArgvError);
		assert.throws(() => sanitizeSpawnEnv({ "A\0": "x" }), UnsafeArgvError);
	});
});

// ─── No-drift invariants (source shape) ───────────────────────────
// A raw spawn in an adapter would bypass the env policy. Each case reads one
// module as text, so a later caller cannot quietly reintroduce it.

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(HERE, "..", "..");
const readSource = (rel: string) => readFileSync(join(EXT_DIR, rel), "utf8");

describe("spawn seam — no policy drift", () => {
	it("exec-env.ts delegates to spawnArgv, never a raw spawn", () => {
		const src = readSource("lib/exec-env.ts");
		assert.match(
			src,
			/import\s*\{[^}]*\bspawnArgv\b[^}]*\}\s*from\s*"\.\/safe-argv\.ts"/,
			"exec-env.ts must import spawnArgv from the policy module",
		);
		assert.doesNotMatch(
			src,
			/\bspawn\s*\(/,
			"exec-env.ts must delegate its spawn to the policy seam",
		);
	});

	it("exec-env.ts owns no env rule of its own", () => {
		assert.doesNotMatch(
			readSource("lib/exec-env.ts"),
			/sanitizeSpawnEnv/,
			"env policy lives in exactly one module (safe-argv.ts)",
		);
	});

	it("safe-argv.ts exports the policy primitives, never opts into a shell", () => {
		const src = readSource("lib/safe-argv.ts");
		assert.match(src, /export\s+function\s+spawnArgv\b/, "spawnArgv export");
		assert.match(src, /export\s+function\s+sanitizeSpawnEnv\b/, "sanitizeSpawnEnv export");
		assert.match(src, /export\s+function\s+assertNoShell\b/, "assertNoShell export");
		assert.match(src, /export\s+function\s+argvCommand\b/, "argvCommand export");
		assert.doesNotMatch(src, /shell:\s*true/, "no spawn may opt back into a shell");
	});

	it("the supervisor agent child routes argv/env through the policy", () => {
		// The single-child_process-importer guard under runner/ lives in
		// supervisor/test/runner-split.test.mts; this pins the policy import.
		const src = readSource("supervisor/agent/runner/spawn.ts");
		const fromPolicy = '\\s*from\\s*"[^"]*lib\\/safe-argv\\.ts"';
		assert.match(
			src,
			new RegExp(`import\\s*\\{[^}]*\\bargvCommand\\b[^}]*\\}${fromPolicy}`),
			"argvCommand import",
		);
		assert.match(
			src,
			new RegExp(`import\\s*\\{[^}]*\\bassertNoShell\\b[^}]*\\}${fromPolicy}`),
			"assertNoShell import",
		);
		assert.match(
			src,
			new RegExp(`import\\s*\\{[^}]*\\bsanitizeSpawnEnv\\b[^}]*\\}${fromPolicy}`),
			"sanitizeSpawnEnv import",
		);
	});
});
