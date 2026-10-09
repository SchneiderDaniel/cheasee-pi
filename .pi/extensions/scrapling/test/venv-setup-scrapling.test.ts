/**
 * Tests for scrapling venv-setup adapter.
 *
 * Layer: adapter — verifies that the thin wrapper calls ensureVenv
 * with correct scrapling-specific config via exec mock inspection, and that
 * browser provisioning is delegated to ensureStealthBrowser (browser-setup.ts).
 *
 * NOTE: structural tests (lock lifecycle, venv creation sequence, mock factory)
 * moved to .pi/extensions/lib/ensureVenv.test.ts. This file tests only the
 * adapter boundary.
 *
 * Split contract (issue #1986): the Python venv and the Chromium browser are two
 * independent provisioning steps. A missing/mismatched browser must NOT destroy a
 * healthy venv (no rm, no venv create, no pip re-run) and must fail fast with a
 * typed error instead of blocking ~8 minutes on an unwritable cache.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExecFn, ExecResult } from "../types.ts";
import { ensureScraplingVenv } from "../venv-setup.ts";

// ── Helpers ──

function assertEnsureVenvError(err: unknown, expectedFragment: string): void {
	assert.ok(err instanceof Error, "error should be an Error");
	assert.equal((err as Error).name, "EnsureVenvError", "error name should be EnsureVenvError");
	assert.ok(
		(err as Error).message.includes(expectedFragment),
		`error message "${(err as Error).message}" should contain "${expectedFragment}"`,
	);
}

interface TrackedCall {
	cmd: string;
	args: string[];
	opts?: { timeout?: number; signal?: AbortSignal; maxBuffer?: number };
}

function trackedCalls(exec: ReturnType<typeof mock.fn<ExecFn>>): TrackedCall[] {
	return exec.mock.calls.map((c) => ({
		cmd: c.arguments[0] as string,
		args: c.arguments[1] as string[],
		opts: c.arguments[2] as TrackedCall["opts"],
	}));
}

function isPatchrightInstall(call: TrackedCall): boolean {
	return call.cmd.includes("bin/python3") && call.args[0] === "-m" && call.args[1] === "patchright";
}

function isPipInstall(call: TrackedCall): boolean {
	return call.cmd.includes("bin/python3") && call.args[1] === "pip";
}

// ── Mock exec factory ──

const PY_VERIFY_OK: ExecResult = { code: 0, stdout: "ok", stderr: "", killed: false };

interface MockHandlers {
	/** Scrapling import verify while the venv is NOT yet set up. */
	pythonVerify?: ExecResult;
	/** Chromium revision probe (browser-setup). Default: 1234. */
	revision?: ExecResult;
	create?: ExecResult;
	install?: ExecResult;
	patchrightInstall?: ExecResult;
}

const DEFAULT: Required<MockHandlers> = {
	pythonVerify: {
		code: 1,
		stdout: "",
		stderr: "ModuleNotFoundError: No module named 'scrapling'",
		killed: false,
	},
	revision: { code: 0, stdout: "1234\n", stderr: "", killed: false },
	create: { code: 0, stdout: "", stderr: "", killed: false },
	install: { code: 0, stdout: "", stderr: "", killed: false },
	patchrightInstall: { code: 0, stdout: "", stderr: "", killed: false },
};

/**
 * Exec mock modelling the two provisioning steps:
 * - `-c` containing `browsers.json` → revision probe; `-c` otherwise → the
 *   scrapling import verify (`pythonVerify` until a pip install succeeded —
 *   `venvReady` starts the venv out healthy, so tests can pick the quick path).
 * - `-m patchright install` → browser download; on success it materialises
 *   `<PLAYWRIGHT_BROWSERS_PATH>/chromium-<rev>`, so the post-install presence
 *   check sees the same filesystem the real install would produce.
 */
function makeMockExec(handlers: MockHandlers = {}, opts: { venvReady?: boolean } = {}): ExecFn {
	const merged = { ...DEFAULT, ...handlers };
	let venvReady = opts.venvReady ?? false;

	return async (cmd: string, args: string[]): Promise<ExecResult> => {
		if (cmd.includes("bin/python3") && args[0] === "-c") {
			if ((args[1] ?? "").includes("browsers.json")) return merged.revision;
			return venvReady ? PY_VERIFY_OK : merged.pythonVerify;
		}
		if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
			try {
				const venvPath = args[args.length - 1];
				fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
				fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
			} catch {
				// fine
			}
			if (merged.create.code === 0) venvReady = true;
			return merged.create;
		}
		if (cmd.includes("bin/python3") && args[0] === "-m" && args[1] === "pip") {
			if (merged.install.code === 0) venvReady = true;
			return merged.install;
		}
		if (isPatchrightInstall({ cmd, args })) {
			const result = merged.patchrightInstall;
			if (result.code === 0 && !result.killed) {
				const rev = merged.revision.stdout.trim();
				const cache =
					process.env.PLAYWRIGHT_BROWSERS_PATH ??
					path.join(os.homedir(), ".cache", "ms-playwright");
				try {
					fs.mkdirSync(path.join(cache, `chromium-${rev}`, "chrome-linux64"), {
						recursive: true,
					});
				} catch {
					// fine — presence check then fails loudly, as it should
				}
			}
			return result;
		}
		if (cmd === "rm") return { code: 0, stdout: "", stderr: "", killed: false };
		return { code: 1, stdout: "", stderr: "mock: unhandled", killed: false };
	};
}

interface TestContext {
	cwd: string;
	cacheRoot: string;
	exec: ReturnType<typeof mock.fn<ExecFn>>;
}

function setupTest(
	handlers: MockHandlers = {},
	opts: { browserPresent?: boolean; rev?: string; venvReady?: boolean } = {},
): TestContext {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrapling-adapter-"));
	const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scrapling-cache-"));
	const rev = opts.rev ?? "1234";
	if (opts.browserPresent) {
		fs.mkdirSync(path.join(cacheRoot, `chromium-${rev}`, "chrome-linux64"), { recursive: true });
		fs.writeFileSync(path.join(cacheRoot, `chromium-${rev}`, "chrome-linux64", "chrome"), "");
	}
	// The env contract the image sets; browser presence is read from the real FS.
	process.env.PLAYWRIGHT_BROWSERS_PATH = cacheRoot;

	const execFn = makeMockExec(handlers, { venvReady: opts.venvReady });
	const tracked: TrackedCall[] = [];
	const wrapped: ExecFn = async (cmd, args, execOpts) => {
		tracked.push({ cmd, args, opts: execOpts });
		return execFn(cmd, args, execOpts);
	};
	const exec = mock.fn(wrapped) as ReturnType<typeof mock.fn<ExecFn>>;

	return { cwd, cacheRoot, exec };
}

// ══════════════════════════════════════════════════════════════════════
//  Adapter tests
// ══════════════════════════════════════════════════════════════════════

describe("ensureScraplingVenv — adapter", () => {
	it("(entity) returns python path containing '.pi/scrapling-venv'", async () => {
		const { cwd, exec } = setupTest();
		const result = await ensureScraplingVenv(exec, cwd);
		assert.ok(result.includes(".pi/scrapling-venv"), "path should reference scrapling-venv");
		assert.ok(result.endsWith("/bin/python3"), "path should end with python3");
	});

	it("(entity) pip install includes scrapling[fetchers], markdownify, beautifulsoup4", async () => {
		const { cwd, exec } = setupTest();

		await ensureScraplingVenv(exec, cwd);

		const calls = trackedCalls(exec);
		const pipCall = calls.find(
			(c) =>
				c.cmd.includes("bin/python3") &&
				c.args.includes("-m") &&
				c.args.includes("pip") &&
				c.args.includes("install"),
		);
		assert.ok(pipCall, "should call pip install");
		assert.ok(pipCall.args.includes("scrapling[fetchers]"), "should install scrapling[fetchers]");
		assert.ok(pipCall.args.includes("markdownify"), "should install markdownify");
		assert.ok(pipCall.args.includes("beautifulsoup4"), "should install beautifulsoup4");
	});

	it("(entity) SCRAPLING_PIP_CONSTRAINTS pointing at a file → pip args include -c <path>", async () => {
		const { cwd, exec } = setupTest();
		const constraints = path.join(cwd, "scrapling-constraints.txt");
		fs.writeFileSync(constraints, "scrapling==0.4.15\n");
		process.env.SCRAPLING_PIP_CONSTRAINTS = constraints;
		try {
			await ensureScraplingVenv(exec, cwd);
		} finally {
			delete process.env.SCRAPLING_PIP_CONSTRAINTS;
		}

		const pipCall = trackedCalls(exec).find(isPipInstall);
		assert.ok(pipCall, "should call pip install");
		const idx = pipCall.args.indexOf("-c");
		assert.ok(idx >= 0, `pip args should carry -c: ${pipCall.args.join(" ")}`);
		assert.equal(pipCall.args[idx + 1], constraints);
	});

	it("(entity) SCRAPLING_PIP_CONSTRAINTS unset → no -c arg (dev-machine behaviour preserved)", async () => {
		const { cwd, exec } = setupTest();
		delete process.env.SCRAPLING_PIP_CONSTRAINTS;

		await ensureScraplingVenv(exec, cwd);

		const pipCall = trackedCalls(exec).find(isPipInstall);
		assert.ok(pipCall, "should call pip install");
		assert.ok(!pipCall.args.includes("-c"), `no -c without the env contract: ${pipCall.args.join(" ")}`);
	});

	it("(entity) SCRAPLING_PIP_CONSTRAINTS pointing at a missing file → no -c arg", async () => {
		const { cwd, exec } = setupTest();
		process.env.SCRAPLING_PIP_CONSTRAINTS = path.join(cwd, "does-not-exist.txt");
		try {
			await ensureScraplingVenv(exec, cwd);
		} finally {
			delete process.env.SCRAPLING_PIP_CONSTRAINTS;
		}

		const pipCall = trackedCalls(exec).find(isPipInstall);
		assert.ok(pipCall, "should call pip install");
		assert.ok(!pipCall.args.includes("-c"), "a missing constraints file must not reach pip");
	});

	it("(entity) verifyCommand asserts Python-import readiness only (no browser knowledge)", async () => {
		const { cwd, exec } = setupTest({}, { browserPresent: true });

		await ensureScraplingVenv(exec, cwd);

		const calls = trackedCalls(exec);
		const verifyCall = calls.find(
			(c) => c.cmd.includes("bin/python3") && c.args[0] === "-c" && !c.args[1].includes("browsers.json"),
		);
		assert.ok(verifyCall, "quick verify should run the verifyCommand");
		const verifyCommand = verifyCall.args[1];
		assert.ok(verifyCommand.includes("StealthyFetcher"), "should import the stealth fetcher");
		assert.ok(verifyCommand.includes("markdownify"), "should import markdownify");
		assert.ok(verifyCommand.includes("print('ok')"), "should print('ok') on success");
		assert.ok(!verifyCommand.includes("browsers.json"), "browser contract must leave the venv verify");
		assert.ok(!verifyCommand.includes("chromium-"), "browser contract must leave the venv verify");
	});

	it("(adapter) browser provisioning runs after the venv resolves and receives its pythonPath", async () => {
		const { cwd, exec } = setupTest();

		const pythonPath = await ensureScraplingVenv(exec, cwd);

		const calls = trackedCalls(exec);
		const probe = calls.find((c) => c.args[0] === "-c" && c.args[1].includes("browsers.json"));
		assert.ok(probe, "browser provisioning must probe the expected revision");
		assert.equal(probe.cmd, pythonPath, "browser probe must run the resolved venv python");
	});

	it("(adapter) healthy venv + browser present → zero pip/install subprocesses", async () => {
		const { cwd, exec } = setupTest({}, { browserPresent: true, venvReady: true });

		const result = await ensureScraplingVenv(exec, cwd);

		const calls = trackedCalls(exec);
		assert.ok(result.includes(".pi/scrapling-venv"), "should return the venv pythonPath");
		assert.ok(!calls.some((c) => c.cmd === "rm"), "must not rm a verified venv");
		assert.ok(
			!calls.some((c) => c.cmd === "python3" && c.args[0] === "-m" && c.args[1] === "venv"),
			"must not recreate a verified venv",
		);
		assert.ok(!calls.some(isPipInstall), "no pip");
		assert.ok(!calls.some(isPatchrightInstall), "no patchright install");
	});

	it("(adapter) healthy venv + missing browser → browser only: no rm, no venv create, no pip re-run", async () => {
		const { cwd, exec } = setupTest({}, { venvReady: true });

		const result = await ensureScraplingVenv(exec, cwd);

		const calls = trackedCalls(exec);
		assert.ok(result.includes(".pi/scrapling-venv"), "should return the venv pythonPath");
		assert.ok(!calls.some((c) => c.cmd === "rm"), "a browser miss must not destroy the venv");
		assert.ok(
			!calls.some((c) => c.cmd === "python3" && c.args[0] === "-m" && c.args[1] === "venv"),
			"a browser miss must not recreate the venv",
		);
		assert.ok(!calls.some(isPipInstall), "a browser miss must not re-run pip");
		assert.equal(calls.filter(isPatchrightInstall).length, 1, "browser self-heal runs once");
	});

	it("(entity) propagates EnsureVenvError without swallowing", async () => {
		const { cwd, exec } = setupTest({
			install: { code: 1, stdout: "", stderr: "pip install failed", killed: false },
		});

		await assert.rejects(
			() => ensureScraplingVenv(exec, cwd),
			(err: unknown) => (err as Error).name === "EnsureVenvError",
		);
	});

	it("(entity) call shape unchanged: (exec, cwd, onUpdate?) still works, browserOpts optional", () => {
		assert.equal(typeof ensureScraplingVenv, "function");
		// exec, cwd, onUpdate, browserOpts — the trailing browser seam is optional,
		// so PythonAdapter's 3-arg EnsureVenvFn call is unaffected.
		assert.equal(ensureScraplingVenv.length, 4);
	});

	// ── browser failure propagation ──

	it("(error) non-writable cache + missing browser → EnsureBrowserError, no patchright install", async () => {
		const { cwd, cacheRoot, exec } = setupTest({}, { venvReady: true });

		let err: unknown;
		try {
			await ensureScraplingVenv(exec, cwd, undefined, { cacheRoot, isWritable: () => false });
		} catch (e) {
			err = e;
		}

		assert.ok(err instanceof Error, "browser failure must surface as an Error");
		assert.equal((err as Error).name, "EnsureBrowserError", "typed browser failure expected");
		assert.ok(
			(err as Error).message.includes("1234"),
			`error must name the expected revision: ${(err as Error).message}`,
		);
		assert.ok(
			(err as Error).message.includes(cacheRoot),
			`error must name the cache root: ${(err as Error).message}`,
		);
		assert.equal(
			trackedCalls(exec).filter(isPatchrightInstall).length,
			0,
			"a non-writable cache must fail fast, never attempt the ~8 min install",
		);
	});

	it("(error) patchright install failure propagates with stderr (never silent pass)", async () => {
		const { cwd, exec } = setupTest(
			{
				patchrightInstall: {
					code: 1,
					stdout: "",
					stderr: "EACCES: permission denied, mkdir '/opt/playwright-browsers/__dirlock'",
					killed: false,
				},
			},
			{ venvReady: true },
		);

		let err: unknown;
		try {
			await ensureScraplingVenv(exec, cwd);
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error, "install failure must surface");
		assert.ok(
			(err as Error).message.includes("EACCES: permission denied"),
			`error must include stderr: ${(err as Error).message}`,
		);
	});

	it("(error) patchright install signal-killed → typed error", async () => {
		const { cwd, exec } = setupTest({ patchrightInstall: { code: 0, stdout: "", stderr: "", killed: true } }, { venvReady: true });

		let err: unknown;
		try {
			await ensureScraplingVenv(exec, cwd);
		} catch (e) {
			err = e;
		}
		assert.ok(err instanceof Error, "killed install must surface");
	});

	it("(regression) browser provisioning delegates to patchright, never scrapling.cli/playwright", async () => {
		const { cwd, exec } = setupTest();
		await ensureScraplingVenv(exec, cwd);
		for (const call of trackedCalls(exec)) {
			assert.ok(
				!call.args.includes("scrapling.cli"),
				`must not invoke scrapling.cli (delegates to patchright's registry): ${call.args.join(" ")}`,
			);
			assert.ok(
				!call.args.includes("playwright"),
				`must not invoke playwright (patchright owns the stealth-tier registry): ${call.args.join(" ")}`,
			);
		}
	});
});
