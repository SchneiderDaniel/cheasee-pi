/**
 * Regression net for the rtk version-gate lifecycle refactor (issue #1779).
 *
 * The factory must be registration-only: no processes, no sockets, no timers.
 * The version probe lives in a memoized gate invoked from `session_start`
 * (fail-fast, clean startup log) and lazily from `tool_call` (headless backstop).
 *
 * Phases:
 *   1. Factory is registration-only (no lifecycle I/O)
 *   2. Version gate decisions (fresh fake pi per scenario)
 *   3. tool_call gate integration + kill switch
 *   4. Rewrite-path regression
 *   5. End-to-end lifecycle (real pi + fake rtk)
 *   6. Docs + wiring consistency
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import factory from "../index.ts";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRegistered } from "../../../../test/lib/test-discovery.mts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const DOC_PATH = join(ROOT, "docs", "extensions", "rtk.md");
const TEST_PATH_WIRING = ".pi/extensions/rtk/test/version-gate.test.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (event: any, ctx: any) => any;
type ExecImpl = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

interface FakePi {
	pi: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	calls: { cmd: string; args: string[]; opts?: ExecOptions }[];
}

function makePi(execImpl: ExecImpl): FakePi {
	const handlers = new Map<string, Handler[]>();
	const calls: { cmd: string; args: string[]; opts?: ExecOptions }[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		async exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
			calls.push({ cmd, args, opts });
			return execImpl(cmd, args, opts);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, calls };
}

function ok(stdout: string): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

function fail(code: number, stdout = "", stderr = ""): ExecResult {
	return { stdout, stderr, code, killed: false };
}

function killedProbe(): ExecResult {
	return { stdout: "", stderr: "", code: null as unknown as number, killed: true };
}

function deferred<T>() {
	let resolveFn!: (v: T) => void;
	let rejectFn!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolveFn = res;
		rejectFn = rej;
	});
	return { promise, resolve: resolveFn, reject: rejectFn };
}

const versionCalls = (f: FakePi) => f.calls.filter((c) => c.args[0] === "--version");
const rewriteCalls = (f: FakePi) => f.calls.filter((c) => c.args[0] === "rewrite");

async function fireSessionStart(f: FakePi): Promise<void> {
	for (const h of f.handlers.get("session_start") ?? []) {
		await h({ type: "session_start", reason: "startup" }, {});
	}
}

async function fireBash(f: FakePi, command: string): Promise<any> {
	const event: any = {
		type: "tool_call",
		toolCallId: "t1",
		toolName: "bash",
		input: { command },
	};
	for (const h of f.handlers.get("tool_call") ?? []) {
		await h(event, {});
	}
	return event;
}

/** Fresh fake pi whose gate is probed via `session_start`. */
async function enabledPi(execImpl: ExecImpl): Promise<FakePi> {
	const f = makePi(execImpl);
	await factory(f.pi);
	await fireSessionStart(f);
	return f;
}

let warnings: unknown[][] = [];
let originalWarn: typeof console.warn;
let savedDisabled: string | undefined;

beforeEach(() => {
	warnings = [];
	originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args);
	};
	savedDisabled = process.env.RTK_DISABLED;
	delete process.env.RTK_DISABLED;
});

afterEach(() => {
	console.warn = originalWarn;
	if (savedDisabled === undefined) delete process.env.RTK_DISABLED;
	else process.env.RTK_DISABLED = savedDisabled;
});

function warnText(): string {
	return warnings.map((w) => w.map(String).join(" ")).join("\n");
}

// ---------------------------------------------------------------------------
// Phase 1: Factory is registration-only (no lifecycle I/O)
// ---------------------------------------------------------------------------

describe("Phase 1: Factory is registration-only", () => {
	it("does not spawn any process from the factory", async () => {
		const f = makePi(async () => ok("rtk 0.45.0"));
		await factory(f.pi);
		assert.equal(f.calls.length, 0, "factory must not call pi.exec");
	});

	it("registers exactly one session_start and one tool_call handler", async () => {
		const f = makePi(async () => ok("rtk 0.45.0"));
		await factory(f.pi);
		assert.equal(f.handlers.get("session_start")?.length ?? 0, 1);
		assert.equal(f.handlers.get("tool_call")?.length ?? 0, 1);
	});

	it("emits zero console.warn calls", async () => {
		const f = makePi(async () => ok("rtk 0.45.0"));
		await factory(f.pi);
		assert.equal(warnings.length, 0);
	});

	it("resolves while pi.exec never settles (no factory I/O await)", async () => {
		const f = makePi(() => new Promise<ExecResult>(() => {}));
		const outcome = await Promise.race([
			factory(f.pi).then(() => "resolved"),
			new Promise((r) => setTimeout(() => r("timeout"), 300)),
		]);
		assert.equal(outcome, "resolved");
	});
});

// ---------------------------------------------------------------------------
// Phase 2: Version gate decisions
// ---------------------------------------------------------------------------

describe("Phase 2: Version gate decisions", () => {
	function versionPi(stdout: string) {
		return makePi(async (_cmd, args) => {
			if (args[0] === "--version") return ok(stdout);
			return fail(1);
		});
	}

	it("enables rtk 0.23.0 with no warning", async () => {
		const f = versionPi("rtk 0.23.0");
		await factory(f.pi);
		await fireSessionStart(f);
		assert.equal(versionCalls(f).length, 1);
		assert.equal(warnings.length, 0);
	});

	it("enables rtk 0.45.0 with no warning", async () => {
		const f = versionPi("rtk 0.45.0");
		await factory(f.pi);
		await fireSessionStart(f);
		assert.equal(warnings.length, 0);
	});

	it("disables rtk 0.22.9 and warns once naming the version and >= 0.23.0", async () => {
		const f = versionPi("rtk 0.22.9");
		await factory(f.pi);
		await fireSessionStart(f);
		assert.equal(warnings.length, 1);
		assert.match(warnText(), /0\.22\.9/);
		assert.match(warnText(), /0\.23\.0/);
	});

	it("disables on non-zero exit (binary not found) and warns once", async () => {
		const f = makePi(async () => fail(1, "", "ENOENT"));
		await factory(f.pi);
		await fireSessionStart(f);
		assert.equal(warnings.length, 1);
		assert.match(warnText(), /not found/i);
	});

	it("disables when pi.exec rejects and warns once (no unhandled rejection)", async () => {
		const f = makePi(async () => {
			throw new Error("spawn ENOENT");
		});
		await factory(f.pi);
		await fireSessionStart(f);
		assert.equal(warnings.length, 1);
	});

	it("disables on killed probe (timeout) and warns once", async () => {
		const f = makePi(async () => killedProbe());
		await factory(f.pi);
		await fireSessionStart(f);
		assert.equal(warnings.length, 1);
	});

	it("fail-open: 'rtk unknown' parses to null → enabled, no warning", async () => {
		const f = versionPi("rtk unknown");
		await factory(f.pi);
		await fireSessionStart(f);
		assert.equal(warnings.length, 0);
	});

	it("fail-open: 'rtk 0.23' (two-component) → enabled, no warning", async () => {
		const f = versionPi("rtk 0.23");
		await factory(f.pi);
		await fireSessionStart(f);
		assert.equal(warnings.length, 0);
	});

	it("enables prerelease 'rtk 0.23.0-beta.1'", async () => {
		const f = versionPi("rtk 0.23.0-beta.1");
		await factory(f.pi);
		await fireSessionStart(f);
		assert.equal(warnings.length, 0);
	});

	it("enables major > 0 ('rtk 1.0.0')", async () => {
		const f = versionPi("rtk 1.0.0");
		await factory(f.pi);
		await fireSessionStart(f);
		assert.equal(warnings.length, 0);
	});

	it("probes with `rtk --version` and a 500ms timeout (not 2000)", async () => {
		const f = versionPi("rtk 0.45.0");
		await factory(f.pi);
		await fireSessionStart(f);
		const probe = versionCalls(f)[0];
		assert.equal(probe.cmd, "rtk");
		assert.deepEqual(probe.args, ["--version"]);
		assert.equal(probe.opts?.timeout, 500);
	});

	it("memoizes: two session_start invocations run one --version exec", async () => {
		const f = versionPi("rtk 0.45.0");
		await factory(f.pi);
		await fireSessionStart(f);
		await fireSessionStart(f);
		assert.equal(versionCalls(f).length, 1);
	});

	it("warns exactly once across two session_start invocations when disabled", async () => {
		const f = versionPi("rtk 0.22.9");
		await factory(f.pi);
		await fireSessionStart(f);
		await fireSessionStart(f);
		assert.equal(warnings.length, 1);
	});

	it("coalesces concurrent probes into one --version exec", async () => {
		const gate = deferred<ExecResult>();
		const f = makePi(() => gate.promise);
		await factory(f.pi);
		const p1 = fireSessionStart(f);
		const p2 = fireSessionStart(f);
		gate.resolve(ok("rtk 0.45.0"));
		await Promise.all([p1, p2]);
		assert.equal(versionCalls(f).length, 1);
	});

	it("isolates cache per runtime: two distinct pi objects probe twice", async () => {
		const a = versionPi("rtk 0.45.0");
		const b = versionPi("rtk 0.45.0");
		await factory(a.pi);
		await factory(b.pi);
		await fireSessionStart(a);
		await fireSessionStart(b);
		assert.equal(versionCalls(a).length, 1);
		assert.equal(versionCalls(b).length, 1);
	});
});

// ---------------------------------------------------------------------------
// Phase 3: tool_call gate integration + kill switch
// ---------------------------------------------------------------------------

describe("Phase 3: tool_call gate integration + kill switch", () => {
	function rewritePi(versionResult: ExecResult) {
		return makePi(async (_cmd, args) => {
			if (args[0] === "--version") return versionResult;
			return ok(`rtk ${args[1]}`);
		});
	}

	it("enabled gate: bash tool_call rewrites the command", async () => {
		const f = await enabledPi(async (_cmd, args) => {
			if (args[0] === "--version") return ok("rtk 0.45.0");
			return ok("rtk git status");
		});
		const event = await fireBash(f, "git status");
		assert.equal(event.input.command, "rtk git status");
		assert.equal(rewriteCalls(f).length, 1);
	});

	it("disabled gate: bash tool_call performs no rewrite", async () => {
		const f = await enabledPi(async (_cmd, args) => {
			if (args[0] === "--version") return fail(1);
			return ok("rtk git status");
		});
		const event = await fireBash(f, "git status");
		assert.equal(event.input.command, "git status");
		assert.equal(rewriteCalls(f).length, 0);
	});

	it("lazy backstop: bash tool_call without session_start probes then rewrites", async () => {
		const f = makePi(async (_cmd, args) => {
			if (args[0] === "--version") return ok("rtk 0.45.0");
			return ok("rtk git status");
		});
		await factory(f.pi);
		const event = await fireBash(f, "git status");
		assert.equal(versionCalls(f).length, 1);
		assert.equal(rewriteCalls(f).length, 1);
		assert.equal(event.input.command, "rtk git status");
	});

	it("RTK_DISABLED=1 suppresses the session_start probe spawn", async () => {
		process.env.RTK_DISABLED = "1";
		const f = makePi(async () => ok("rtk 0.45.0"));
		await factory(f.pi);
		await fireSessionStart(f);
		assert.equal(f.calls.length, 0);
	});

	it("RTK_DISABLED=1 suppresses probe and rewrite in tool_call", async () => {
		process.env.RTK_DISABLED = "1";
		const f = makePi(async () => ok("rtk 0.45.0"));
		await factory(f.pi);
		await fireBash(f, "git status");
		assert.equal(f.calls.length, 0);
	});

	it("reads RTK_DISABLED at call time: cached enabled gate then disabled makes no rewrite", async () => {
		const f = await enabledPi(async (_cmd, args) => {
			if (args[0] === "--version") return ok("rtk 0.45.0");
			return ok("rtk git status");
		});
		process.env.RTK_DISABLED = "1";
		const event = await fireBash(f, "git status");
		assert.equal(event.input.command, "git status");
		assert.equal(rewriteCalls(f).length, 0);
	});

	it("already rtk-prefixed command performs no exec", async () => {
		const f = makePi(async () => ok("rtk 0.45.0"));
		await factory(f.pi);
		await fireBash(f, "rtk git status");
		assert.equal(f.calls.length, 0);
	});

	it("non-bash tool_call performs no exec", async () => {
		const f = makePi(async () => ok("rtk 0.45.0"));
		await factory(f.pi);
		const event: any = { type: "tool_call", toolCallId: "t", toolName: "read", input: { path: "x" } };
		for (const h of f.handlers.get("tool_call") ?? []) await h(event, {});
		assert.equal(f.calls.length, 0);
	});

	it("empty/whitespace command performs no exec", async () => {
		const f = makePi(async () => ok("rtk 0.45.0"));
		await factory(f.pi);
		await fireBash(f, "");
		await fireBash(f, "   ");
		assert.equal(f.calls.length, 0);
	});
});

// ---------------------------------------------------------------------------
// Phase 4: Rewrite-path regression
// ---------------------------------------------------------------------------

describe("Phase 4: Rewrite-path regression", () => {
	async function rewriteWith(result: ExecResult, cmd = "git status") {
		const f = await enabledPi(async (_c, args) => {
			if (args[0] === "--version") return ok("rtk 0.45.0");
			return result;
		});
		const event = await fireBash(f, cmd);
		return { f, event };
	}

	it("code 0 with rewrite mutates the command", async () => {
		const { event } = await rewriteWith(ok("rtk git status"));
		assert.equal(event.input.command, "rtk git status");
	});

	it("code 3 (advisory) with rewrite mutates the command", async () => {
		const { event } = await rewriteWith({ stdout: "rtk git diff", stderr: "", code: 3, killed: false });
		assert.equal(event.input.command, "rtk git diff");
	});

	it("code 1 passes through unchanged", async () => {
		const { event } = await rewriteWith(fail(1));
		assert.equal(event.input.command, "git status");
	});

	it("killed rewrite passes through unchanged", async () => {
		const { event } = await rewriteWith(killedProbe());
		assert.equal(event.input.command, "git status");
	});

	it("code 2 passes through unchanged", async () => {
		const { event } = await rewriteWith(fail(2));
		assert.equal(event.input.command, "git status");
	});

	it("code 0 with empty stdout passes through unchanged", async () => {
		const { event } = await rewriteWith(ok(""));
		assert.equal(event.input.command, "git status");
	});

	it("code 0 with identical stdout passes through unchanged", async () => {
		const { event } = await rewriteWith(ok("git status"));
		assert.equal(event.input.command, "git status");
	});

	it("injects --level aggressive into rtk read rewrites", async () => {
		const { event } = await rewriteWith(ok("rtk read foo"));
		assert.equal(event.input.command, "rtk read --level aggressive foo");
	});

	it("rewrite rejection resolves, leaves command unchanged, warns once", async () => {
		const f = await enabledPi(async (_c, args) => {
			if (args[0] === "--version") return ok("rtk 0.45.0");
			throw new Error("boom");
		});
		const event = await fireBash(f, "git status");
		assert.equal(event.input.command, "git status");
		assert.equal(warnings.length, 1);
	});
});

// ---------------------------------------------------------------------------
// Phase 5: End-to-end lifecycle (real pi + fake rtk)
// ---------------------------------------------------------------------------

describe("Phase 5: End-to-end lifecycle", () => {
	/**
	 * Runs a real `pi --help --approve` in an isolated project with a clean agent
	 * dir (so the machine's globally-installed rtk extension cannot interfere) and
	 * returns the marker file contents the fake `rtk` wrote, or "".
	 */
	async function runPiHelp(extensionBody: string): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "rtk-lifecycle-"));
		try {
			const agentDir = join(dir, "agent");
			const project = join(dir, "proj");
			const extDir = join(project, ".pi", "extensions", "rtk");
			await mkdir(agentDir, { recursive: true });
			await mkdir(extDir, { recursive: true });
			await writeFile(join(extDir, "index.ts"), extensionBody);

			const marker = join(dir, "marker");
			const fakeRtk = join(dir, "rtk");
			await writeFile(
				fakeRtk,
				`#!/bin/sh\necho "invoked: $*" >> "$RTK_MARKER"\nif [ "$1" = "--version" ]; then echo "rtk 0.45.0"; exit 0; fi\nexit 1\n`,
			);
			await chmod(fakeRtk, 0o755);

			const env = {
				...process.env,
				PATH: `${dir}:${process.env.PATH ?? ""}`,
				RTK_MARKER: marker,
				PI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
			};
			const res = spawnSync("pi", ["--help", "--approve"], {
				cwd: project,
				env,
				encoding: "utf-8",
				timeout: 60_000,
			});
			assert.equal(res.status, 0, res.stderr);

			try {
				return await readFile(marker, "utf-8");
			} catch {
				return "";
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	it("control: an eager factory probe writes the marker", async () => {
		const eager = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nexport default async function (pi: ExtensionAPI) {\n\tawait pi.exec("rtk", ["--version"], { timeout: 2000 });\n}\n`;
		assert.equal(await runPiHelp(eager), "invoked: --version\n");
	});

	it("pi --help --approve with the refactored extension spawns nothing", async () => {
		const body = readFileSync(join(ROOT, ".pi", "extensions", "rtk", "index.ts"), "utf-8");
		assert.equal(await runPiHelp(body), "");
	});
});

// ---------------------------------------------------------------------------
// Phase 6: Docs + wiring consistency
// ---------------------------------------------------------------------------

describe("Phase 6: Docs + wiring consistency", () => {
	function doc(): string {
		return readFileSync(DOC_PATH, "utf-8");
	}

	it("doc no longer says 'at load time'", () => {
		assert.ok(!/at load time/i.test(doc()), "docs must not claim load-time probing");
	});

	it("version-guard prose and fail-open rows say 'session start'", () => {
		const text = doc();
		assert.match(text, /Version guard at session start/i);
		assert.equal(
			(text.match(/Console warning at session start/g) ?? []).length,
			2,
			"both fail-open rows must point at session start",
		);
	});

	it("RTK_DISABLED=1 row documents that the kill switch suppresses the probe", () => {
		const row = doc()
			.split("\n")
			.find((l) => l.startsWith("|") && l.includes("RTK_DISABLED=1"));
		assert.ok(row, "RTK_DISABLED=1 row present");
		assert.match(row!, /probe|spawn/i);
	});

	it("still documents fail-open rewrite pass-through on error/timeout", () => {
		const text = doc();
		assert.match(text, /rtk rewrite.*returns error/i);
		assert.match(text, /times out.*Pass-through/i);
	});

	it("npm test globs register this version-gate test", () => {
		assert.equal(isRegistered(TEST_PATH_WIRING), true);
	});
});
