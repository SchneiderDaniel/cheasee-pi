/**
 * Tests for scrapling venv-setup adapter.
 *
 * Layer: adapter — verifies that the thin wrapper calls ensureVenv
 * with correct scrapling-specific config via exec mock inspection.
 *
 * NOTE: structural tests (lock lifecycle, venv creation sequence, mock factory)
 * moved to .pi/extensions/lib/ensureVenv.test.ts. This file tests only the
 * adapter boundary.
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

// ── Simple mock factory ──

interface MockHandlers {
	verify?: ExecResult;
	create?: ExecResult;
	install?: ExecResult;
	scraplingCli?: ExecResult;
}

const DEFAULT: Required<MockHandlers> = {
	verify: { code: 1, stdout: "", stderr: "not found", killed: false },
	create: { code: 0, stdout: "", stderr: "", killed: false },
	install: { code: 0, stdout: "", stderr: "", killed: false },
	scraplingCli: { code: 0, stdout: "", stderr: "", killed: false },
};

function makeMockExec(handlers: MockHandlers = {}): ExecFn {
	const merged = { ...DEFAULT, ...handlers };
	const hasCustomVerify = "verify" in handlers;
	let setupDone = false;

	return async (cmd: string, args: string[]) => {
		// Verify check
		if (cmd.includes("bin/python3") && args[0] === "-c") {
			// After venv is set up, return success unless test provided custom verify
			if (setupDone && !hasCustomVerify) {
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
		// patchright chromium post-install (best-effort browser download)
		if (cmd.includes("bin/python3") && args[0] === "-m" && args[1] === "patchright")
			return merged.scraplingCli;
		// rm -rf cleanup
		if (cmd === "rm") return { code: 0, stdout: "", stderr: "", killed: false };
		return { code: 1, stdout: "", stderr: "mock: unhandled", killed: false };
	};
}

interface TestContext {
	cwd: string;
	exec: ReturnType<typeof mock.fn<ExecFn>>;
}

function setupTest(handlers: MockHandlers = {}): TestContext {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrapling-adapter-"));
	const execFn = makeMockExec(handlers);
	const tracked: Array<{ cmd: string; args: string[] }> = [];
	const wrapped: ExecFn = async (cmd, args, opts) => {
		tracked.push({ cmd, args });
		return execFn(cmd, args, opts);
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

		const calls = exec.mock.calls.map((c) => ({
			cmd: c.arguments[0] as string,
			args: c.arguments[1] as string[],
		}));
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

	it("(entity) runs patchright install chromium as best-effort postInstall hook", async () => {
		const { cwd, exec } = setupTest();

		await ensureScraplingVenv(exec, cwd);

		const calls = exec.mock.calls.map((c) => ({
			cmd: c.arguments[0] as string,
			args: c.arguments[1] as string[],
		}));
		const cliCall = calls.find(
			(c) => c.cmd.includes("bin/python3") && c.args.includes("-m") && c.args[1] === "patchright",
		);
		assert.ok(cliCall, "should call patchright install chromium");
		assert.ok(cliCall.args.includes("install"), "should run patchright install");
		assert.ok(
			cliCall.args.includes("chromium"),
			"should install chromium (patchright rev 1228, not playwright 1234)",
		);
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

	// ── postInstall best-effort semantics ──

	it("(entity) patchright chromium non-zero exit does NOT fail venv setup (best-effort)", async () => {
		const { cwd, exec } = setupTest({
			scraplingCli: { code: 1, stdout: "", stderr: "Download failure, code=1", killed: false },
		});

		await assert.doesNotReject(() => ensureScraplingVenv(exec, cwd));
	});

	it("(entity) patchright chromium signal-killed does NOT fail venv setup (best-effort)", async () => {
		const { cwd, exec } = setupTest({
			scraplingCli: { code: 0, stdout: "", stderr: "", killed: true },
		});

		await assert.doesNotReject(() => ensureScraplingVenv(exec, cwd));
	});
});
