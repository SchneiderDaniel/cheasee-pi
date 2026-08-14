/**
 * Tests for scrapling venv-setup adapter.
 *
 * Layer: adapter — verifies that the thin wrapper calls ensureVenv
 * with correct scrapling-specific config via exec mock inspection.
 *
 * NOTE: structural tests (lock lifecycle, venv creation sequence, mock factory)
 * moved to .pi/extensions/lib/ensureVenv.test.ts. This file tests only the
 * adapter boundary.
 *
 * Stealth-tier browser contract: the runtime stealth fetcher resolves its
 * chromium build via patchright's registry (revision 1228 at patchright
 * 1.61.2), NOT playwright's (revision 1234 at playwright 1.62.0). The adapter
 * therefore (a) verifies the patchright-expected build exists and (b) installs
 * it with `python -m patchright install chromium`, never playwright.
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

// ── Simple mock factory ──

interface MockHandlers {
	verify?: ExecResult;
	create?: ExecResult;
	install?: ExecResult;
	patchrightInstall?: ExecResult;
}

const DEFAULT: Required<MockHandlers> = {
	verify: {
		code: 1,
		stdout: "",
		stderr:
			"Stealth-fetcher Chromium missing: expected /opt/playwright-browsers/chromium-1228. Run 'python -m patchright install chromium'.",
		killed: false,
	},
	create: { code: 0, stdout: "", stderr: "", killed: false },
	install: { code: 0, stdout: "", stderr: "", killed: false },
	patchrightInstall: { code: 0, stdout: "", stderr: "", killed: false },
};

/**
 * Exec mock that models the browser-check outcome:
 * - `browserReady` — patchright-expected chromium build present → verify passes
 *   (exit 0, stdout "ok") regardless of venv state.
 * - otherwise verify returns `merged.verify` (default: browser-missing failure).
 * - a successful `-m patchright install` (code 0, not killed) marks the browser
 *   as ready, so the final verify after a full setup passes.
 */
function makeMockExec(handlers: MockHandlers = {}, opts: { browserReady?: boolean } = {}): ExecFn {
	const merged = { ...DEFAULT, ...handlers };
	let browserReady = opts.browserReady ?? false;
	let setupDone = false;

	return async (cmd: string, args: string[]): Promise<ExecResult> => {
		// Verify check
		if (cmd.includes("bin/python3") && args[0] === "-c") {
			if (browserReady) {
				return { code: 0, stdout: "ok", stderr: "", killed: false };
			}
			return merged.verify;
		}
		// Create venv — also create fake python3 binary so the path resolves
		if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
			try {
				const venvPath = args[args.length - 1];
				fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
				fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
			} catch {
				// fine
			}
			const result = merged.create;
			if (result.code === 0) setupDone = true;
			return result;
		}
		// Pip install
		if (cmd.includes("bin/python3") && args[0] === "-m" && args[1] === "pip") {
			const result = merged.install;
			if (result.code === 0) setupDone = true;
			return result;
		}
		// patchright post-install (stealth-tier browser download)
		if (cmd.includes("bin/python3") && args[0] === "-m" && args[1] === "patchright") {
			const result = merged.patchrightInstall;
			if (result.code === 0 && !result.killed) browserReady = true;
			return result;
		}
		// rm -rf cleanup
		if (cmd === "rm") return { code: 0, stdout: "", stderr: "", killed: false };
		return { code: 1, stdout: "", stderr: "mock: unhandled", killed: false };
	};
}

interface TestContext {
	cwd: string;
	exec: ReturnType<typeof mock.fn<ExecFn>>;
}

function setupTest(handlers: MockHandlers = {}, opts?: { browserReady?: boolean }): TestContext {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrapling-adapter-"));
	const execFn = makeMockExec(handlers, opts);
	const tracked: TrackedCall[] = [];
	const wrapped: ExecFn = async (cmd, args, execOpts) => {
		tracked.push({ cmd, args, opts: execOpts });
		return execFn(cmd, args, execOpts);
	};
	const exec = mock.fn(wrapped) as ReturnType<typeof mock.fn<ExecFn>>;
	return { cwd, exec };
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

	it("(entity) runs 'python -m patchright install chromium' as postInstall hook", async () => {
		const { cwd, exec } = setupTest();

		await ensureScraplingVenv(exec, cwd);

		const calls = trackedCalls(exec);
		const prCall = calls.find(
			(c) => c.cmd.includes("bin/python3") && c.args[0] === "-m" && c.args[1] === "patchright",
		);
		assert.ok(prCall, "should call patchright postInstall");
		assert.deepEqual(prCall.args.slice(2), ["install", "chromium"]);
	});

	it("(entity) postInstall patchright install carries timeout 600_000", async () => {
		const { cwd, exec } = setupTest();

		await ensureScraplingVenv(exec, cwd);

		const calls = trackedCalls(exec);
		const prCall = calls.find(
			(c) => c.cmd.includes("bin/python3") && c.args[0] === "-m" && c.args[1] === "patchright",
		);
		assert.ok(prCall, "should call patchright postInstall");
		// Research measured ~2m22s for the chromium download; the old 120s cap
		// would kill a legit install mid-flight.
		assert.equal(prCall.opts?.timeout, 600_000);
	});

	it("(entity) verifyCommand asserts the patchright-expected chromium build", async () => {
		const { cwd, exec } = setupTest({}, { browserReady: true });

		await ensureScraplingVenv(exec, cwd);

		const calls = trackedCalls(exec);
		const verifyCall = calls.find((c) => c.cmd.includes("bin/python3") && c.args[0] === "-c");
		assert.ok(verifyCall, "quick verify should run the verifyCommand");
		const verifyCommand = verifyCall.args[1];
		// Reads the chromium revision from patchright's own registry…
		assert.ok(verifyCommand.includes("import patchright"), "should import patchright");
		assert.ok(verifyCommand.includes("browsers.json"), "should read patchright browsers.json");
		assert.ok(verifyCommand.includes("chromium"), "should look up the chromium revision");
		// …resolves the cache root from the env contract…
		assert.ok(
			verifyCommand.includes("PLAYWRIGHT_BROWSERS_PATH"),
			"should resolve cache root from PLAYWRIGHT_BROWSERS_PATH",
		);
		// …and still prints 'ok' (ensureVenv's success signal) when present.
		assert.ok(verifyCommand.includes("print('ok')"), "should print('ok') on success");
	});

	it("(entity) returns the pythonPath from ensureVenv unchanged", async () => {
		const { cwd, exec } = setupTest();
		const result = await ensureScraplingVenv(exec, cwd);
		assert.ok(typeof result === "string");
		assert.ok(result.length > 0);
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

	it("(entity) signature unchanged: async (exec, cwd, onUpdate?) => Promise<string>", () => {
		assert.equal(typeof ensureScraplingVenv, "function");
		assert.equal(ensureScraplingVenv.length, 3); // exec, cwd, onUpdate
	});

	// ── postInstall exec failure propagation ──

	it("(error) patchright install non-zero exit → EnsureVenvError with step install", async () => {
		const { cwd, exec } = setupTest({
			patchrightInstall: { code: 1, stdout: "", stderr: "Download failure, code=1", killed: false },
		});

		let err: unknown;
		try {
			await ensureScraplingVenv(exec, cwd);
		} catch (e) {
			err = e;
		}
		assertEnsureVenvError(err, "Download failure, code=1");
	});

	it("(error) patchright install signal-killed → EnsureVenvError with step install", async () => {
		const { cwd, exec } = setupTest({
			patchrightInstall: { code: 0, stdout: "", stderr: "", killed: true },
		});

		let err: unknown;
		try {
			await ensureScraplingVenv(exec, cwd);
		} catch (e) {
			err = e;
		}
		assertEnsureVenvError(err, "Post-install step failed");
	});

	it("(error) patchright install failure message includes stderr", async () => {
		const { cwd, exec } = setupTest({
			patchrightInstall: {
				code: 1,
				stdout: "",
				stderr: "size mismatch: expected 200MB got 50MB",
				killed: false,
			},
		});

		let err: unknown;
		try {
			await ensureScraplingVenv(exec, cwd);
		} catch (e) {
			err = e;
		}
		assertEnsureVenvError(err, "size mismatch: expected 200MB got 50MB");
	});

	it("(error) patchright install success (code 0, not killed) does NOT throw", async () => {
		const { cwd, exec } = setupTest({
			patchrightInstall: { code: 0, stdout: "installed", stderr: "", killed: false },
		});

		await assert.doesNotReject(
			() => ensureScraplingVenv(exec, cwd),
		);
	});

	// ── adapter flows (browser-check driven) ──

	it("(adapter) missing browser → full setup (rm → create → pip → patchright postInstall) → verify passes → created", async () => {
		const { cwd, exec } = setupTest(); // browserReady: false

		const result = await ensureScraplingVenv(exec, cwd);

		const calls = trackedCalls(exec);
		assert.ok(calls.some((c) => c.cmd === "rm"), "should rm the broken venv");
		assert.ok(
			calls.some((c) => c.cmd === "python3" && c.args[0] === "-m" && c.args[1] === "venv"),
			"should create the venv",
		);
		assert.ok(
			calls.some((c) => c.cmd.includes("bin/python3") && c.args[1] === "pip"),
			"should pip install",
		);
		assert.ok(
			calls.some(
				(c) => c.cmd.includes("bin/python3") && c.args[0] === "-m" && c.args[1] === "patchright",
			),
			"should run patchright postInstall (self-heal)",
		);
		// Final verify passed → venv fully set up.
		assert.ok(result.includes(".pi/scrapling-venv"), "should return the venv pythonPath");
	});

	it("(adapter) missing browser AND patchright install fails → EnsureVenvError, never silent pass", async () => {
		const { cwd, exec } = setupTest({
			patchrightInstall: {
				code: 1,
				stdout: "",
				stderr: "EACCES: permission denied, mkdir '/opt/playwright-browsers/__dirlock'",
				killed: false,
			},
		});

		let err: unknown;
		try {
			await ensureScraplingVenv(exec, cwd);
		} catch (e) {
			err = e;
		}
		assertEnsureVenvError(err, "EACCES: permission denied");
	});

	it("(adapter) quick path: browser present + stdout 'ok' → created: false, no pip/postInstall", async () => {
		const { cwd, exec } = setupTest({}, { browserReady: true });

		const result = await ensureScraplingVenv(exec, cwd);

		const calls = trackedCalls(exec);
		assert.ok(result.includes(".pi/scrapling-venv"), "should return the venv pythonPath");
		// Quick verify passed → no rm, no create, no pip, no postInstall.
		assert.ok(!calls.some((c) => c.cmd === "rm"), "must not rm a verified venv");
		assert.ok(
			!calls.some((c) => c.cmd === "python3" && c.args[0] === "-m" && c.args[1] === "venv"),
			"must not recreate a verified venv",
		);
		assert.ok(!calls.some((c) => c.cmd.includes("bin/python3") && c.args[1] === "pip"), "no pip");
		assert.ok(
			!calls.some(
				(c) => c.cmd.includes("bin/python3") && c.args[0] === "-m" && c.args[1] === "patchright",
			),
			"no patchright postInstall",
		);
	});

	// ── regression: playwright/scrapling.cli never used for the browser ──

	it("(regression) no scrapling.cli invocation remains in venv-setup.ts or its test", async () => {
		const adapterSource = fs.readFileSync(new URL("../venv-setup.ts", import.meta.url), "utf8");
		const testSource = fs.readFileSync(new URL(import.meta.url), "utf8");
		// Build the needle so this test's own source doesn't contain the literal.
		const cliNeedle = '"' + "scrapling" + ".cli\"";
		for (const [name, src] of [
			["venv-setup.ts", adapterSource],
			["venv-setup-scrapling.test.ts", testSource],
		]) {
			// Invocations appear as the quoted arg in exec calls; comments may
			// legitimately reference the name.
			assert.ok(
				!src.includes(cliNeedle),
				`${name} must not invoke scrapling.cli (it delegates to playwright's registry, wrong revision)`,
			);
		}
	});

	it("(regression) no playwright invocation used for browser provisioning", async () => {
		const adapterSource = fs.readFileSync(new URL("../venv-setup.ts", import.meta.url), "utf8");
		assert.ok(
			!adapterSource.includes('"playwright"'),
			"venv-setup.ts must not invoke playwright (patchright owns the stealth-tier browser registry)",
		);
	});
});
