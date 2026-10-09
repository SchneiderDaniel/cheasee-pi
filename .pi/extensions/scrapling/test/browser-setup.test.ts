/**
 * Tests for the scrapling stealth-browser provisioning gate (browser-setup.ts).
 *
 * Layer: adapter — the module owns the browser-cache contract: which revision
 * patchright resolves, where the cache lives, whether it is writable, and a
 * typed failure when it is not. `isWritable` is injectable because CI/tests run
 * as root, where POSIX mode 0555 still passes access(W_OK).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecFn, ExecResult } from "../types.ts";
import {
	EnsureBrowserError,
	ensureStealthBrowser,
	resolveBrowserCacheRoot,
} from "../browser-setup.ts";

// ── Helpers ──

const PY = "/repo/.pi/scrapling-venv/bin/python3";

const OK: ExecResult = { code: 0, stdout: "", stderr: "", killed: false };

interface TrackedCall {
	cmd: string;
	args: string[];
	opts?: { timeout?: number };
}

interface Handlers {
	revision?: ExecResult;
	install?: ExecResult;
}

interface Mock {
	exec: ExecFn;
	calls: TrackedCall[];
}

/**
 * Mock exec: `-c` → revision probe (patchright browsers.json), `-m patchright`
 * → chromium install. Nothing else is expected, so an unhandled call surfaces
 * as a failing result instead of being silently accepted.
 */
function makeExec(h: Handlers = {}): Mock {
	const calls: TrackedCall[] = [];
	const exec: ExecFn = async (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		if (cmd.includes("bin/python3") && args[0] === "-c") {
			return h.revision ?? { code: 0, stdout: "1234\n", stderr: "", killed: false };
		}
		if (cmd.includes("bin/python3") && args[0] === "-m" && args[1] === "patchright") {
			return h.install ?? OK;
		}
		return { code: 1, stdout: "", stderr: `mock: unhandled ${cmd} ${args.join(" ")}`, killed: false };
	};
	return { exec, calls };
}

function tempCache(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "scrapling-browser-"));
}

/** Create <cache>/chromium-<rev>/chrome-linux64/chrome (patchright layout). */
function writeBrowser(cacheRoot: string, rev: string): void {
	const dir = path.join(cacheRoot, `chromium-${rev}`, "chrome-linux64");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "chrome"), "");
}

function installCalls(calls: TrackedCall[]): TrackedCall[] {
	return calls.filter(
		(c) => c.cmd.includes("bin/python3") && c.args[0] === "-m" && c.args[1] === "patchright",
	);
}

// ══════════════════════════════════════════════════════════════════════
//  Cache root resolution
// ══════════════════════════════════════════════════════════════════════

describe("resolveBrowserCacheRoot", () => {
	it("(entity) PLAYWRIGHT_BROWSERS_PATH set → that path", () => {
		assert.equal(
			resolveBrowserCacheRoot({ PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright-browsers" }),
			"/opt/playwright-browsers",
		);
	});

	it("(entity) unset or empty → ~/.cache/ms-playwright", () => {
		const fallback = path.join(os.homedir(), ".cache", "ms-playwright");
		assert.equal(resolveBrowserCacheRoot({}), fallback);
		assert.equal(resolveBrowserCacheRoot({ PLAYWRIGHT_BROWSERS_PATH: "" }), fallback);
	});
});

// ══════════════════════════════════════════════════════════════════════
//  ensureStealthBrowser
// ══════════════════════════════════════════════════════════════════════

describe("ensureStealthBrowser", () => {
	it("(entity) reads the revision from patchright's browsers.json via exec and uses it verbatim in the cache path", async () => {
		const cacheRoot = tempCache();
		writeBrowser(cacheRoot, "9999");
		const { exec, calls } = makeExec({
			revision: { code: 0, stdout: "9999\n", stderr: "", killed: false },
		});

		await ensureStealthBrowser(PY, exec, { cacheRoot });

		const probe = calls.find((c) => c.args[0] === "-c");
		assert.ok(probe, "must resolve the revision through the injected exec");
		assert.equal(probe.cmd, PY, "probe must run the venv python");
		assert.ok(probe.args[1].includes("patchright"), "probe must import patchright");
		assert.ok(probe.args[1].includes("browsers.json"), "probe must read patchright browsers.json");
		assert.equal(installCalls(calls).length, 0, "matching revision must not trigger an install");
	});

	it("(entity) presence is revision-specific: chromium-<rev> present → resolves with no install subprocess", async () => {
		const cacheRoot = tempCache();
		writeBrowser(cacheRoot, "1234");
		const { exec, calls } = makeExec();

		await ensureStealthBrowser(PY, exec, { cacheRoot });

		assert.equal(installCalls(calls).length, 0, "present browser must not be reinstalled");
	});

	it("(adapter) cache holds chromium-1243 while expected is 1234 → treated as missing", async () => {
		const cacheRoot = tempCache();
		writeBrowser(cacheRoot, "1243");
		const { exec, calls } = makeExec({
			install: { code: 0, stdout: "installed", stderr: "", killed: false },
		});

		await assert.rejects(
			() => ensureStealthBrowser(PY, exec, { cacheRoot, isWritable: () => false }),
			(err: unknown) => err instanceof EnsureBrowserError,
		);
		assert.equal(installCalls(calls).length, 0, "non-writable cache must fail before installing");
	});

	it("(error) missing browser AND non-writable cache → typed error carrying the contract, no install subprocess", async () => {
		const cacheRoot = tempCache();
		const { exec, calls } = makeExec();

		let err: unknown;
		try {
			await ensureStealthBrowser(PY, exec, { cacheRoot, isWritable: () => false });
		} catch (e) {
			err = e;
		}

		assert.ok(err instanceof EnsureBrowserError, "must throw EnsureBrowserError");
		const e = err as EnsureBrowserError;
		assert.equal(e.expectedRevision, "1234");
		assert.equal(e.cacheRoot, cacheRoot);
		assert.equal(e.writable, false);
		assert.ok(e.message.includes("1234"), `message must name the revision: ${e.message}`);
		assert.ok(e.message.includes(cacheRoot), `message must name the cache root: ${e.message}`);
		assert.equal(installCalls(calls).length, 0, "must never attempt a patchright install");
	});

	it("(boundary) non-writable fail-fast issues only the revision probe — no pip/patchright install", async () => {
		const cacheRoot = tempCache();
		const { exec, calls } = makeExec();

		await assert.rejects(
			() => ensureStealthBrowser(PY, exec, { cacheRoot, isWritable: () => false }),
			(err: unknown) => err instanceof EnsureBrowserError,
		);

		assert.equal(calls.length, 1, "exactly one tracked exec call (the revision probe) is expected");
		assert.equal(calls[0].args[0], "-c", "the only call is the revision probe");
	});

	it("(adapter) missing browser AND writable cache → install invoked, resolves once the revision dir exists", async () => {
		const cacheRoot = tempCache();
		const { exec, calls } = makeExec({
			install: { code: 0, stdout: "chromium downloaded", stderr: "", killed: false },
		});
		// Simulate the real install writing the expected build.
		const originalExec = exec;
		const writingExec: ExecFn = async (cmd, args, opts) => {
			const res = await originalExec(cmd, args, opts);
			if (args[0] === "-m" && args[1] === "patchright") writeBrowser(cacheRoot, "1234");
			return res;
		};

		await ensureStealthBrowser(PY, writingExec, { cacheRoot, isWritable: () => true });

		const installs = installCalls(calls);
		assert.equal(installs.length, 1, "writable cache must self-heal via patchright install");
		assert.deepEqual(installs[0].args.slice(2), ["install", "chromium"]);
		assert.equal(installs[0].opts?.timeout, 600_000, "chromium download needs the 600s budget");
	});

	it("(error) install exits non-zero → typed error including stderr", async () => {
		const cacheRoot = tempCache();
		const { exec } = makeExec({
			install: { code: 1, stdout: "", stderr: "EACCES: permission denied", killed: false },
		});

		await assert.rejects(
			() => ensureStealthBrowser(PY, exec, { cacheRoot, isWritable: () => true }),
			(err: unknown) => {
				assert.ok(err instanceof EnsureBrowserError);
				assert.ok((err as Error).message.includes("EACCES: permission denied"));
				return true;
			},
		);
	});

	it("(error) install signal-killed → typed error, never a silent pass", async () => {
		const cacheRoot = tempCache();
		const { exec } = makeExec({
			install: { code: 0, stdout: "", stderr: "", killed: true },
		});

		await assert.rejects(
			() => ensureStealthBrowser(PY, exec, { cacheRoot, isWritable: () => true }),
			(err: unknown) => err instanceof EnsureBrowserError,
		);
	});

	it("(error) install reported success but the revision dir is still absent → typed error", async () => {
		const cacheRoot = tempCache();
		const { exec } = makeExec({
			install: { code: 0, stdout: "installed", stderr: "", killed: false },
		});

		await assert.rejects(
			() => ensureStealthBrowser(PY, exec, { cacheRoot, isWritable: () => true }),
			(err: unknown) => {
				assert.ok(err instanceof EnsureBrowserError);
				assert.ok((err as Error).message.includes("1234"), "message must name the revision");
				return true;
			},
		);
	});

	it("(error) revision probe failure → typed error, no install attempted", async () => {
		const cacheRoot = tempCache();
		const { exec, calls } = makeExec({
			revision: { code: 1, stdout: "", stderr: "ModuleNotFoundError: patchright", killed: false },
		});

		await assert.rejects(
			() => ensureStealthBrowser(PY, exec, { cacheRoot, isWritable: () => true }),
			(err: unknown) => {
				assert.ok(err instanceof EnsureBrowserError);
				assert.ok((err as Error).message.includes("ModuleNotFoundError: patchright"));
				return true;
			},
		);
		assert.equal(installCalls(calls).length, 0, "must fail closed, never install blind");
	});

	it("(error) unparseable revision output → typed error, no install attempted", async () => {
		const cacheRoot = tempCache();
		const { exec, calls } = makeExec({
			revision: { code: 0, stdout: "Traceback (most recent call last)\n", stderr: "", killed: false },
		});

		await assert.rejects(
			() => ensureStealthBrowser(PY, exec, { cacheRoot, isWritable: () => true }),
			(err: unknown) => err instanceof EnsureBrowserError,
		);
		assert.equal(installCalls(calls).length, 0, "must fail closed, never install blind");
	});

	it("(entity) cache root defaults to PLAYWRIGHT_BROWSERS_PATH when opts.cacheRoot is omitted", async () => {
		const cacheRoot = tempCache();
		writeBrowser(cacheRoot, "1234");
		const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
		process.env.PLAYWRIGHT_BROWSERS_PATH = cacheRoot;
		try {
			const { exec, calls } = makeExec();
			await ensureStealthBrowser(PY, exec, { isWritable: () => true });
			assert.equal(installCalls(calls).length, 0, "env-resolved cache root must be honoured");
		} finally {
			if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
			else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
		}
	});
});
