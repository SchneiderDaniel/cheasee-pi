// ─── rtk version-gate: rewrite path + lifecycle + docs ───────────
// Split from version-gate.test.ts (issue #2005 Long File refactor).
// Same harness preamble; scenario seam at Phase 4.
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

import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { isRegistered } from "../../../../test/lib/test-discovery.mts";
import {
	captureWarnings,
	enabledPi,
	fail,
	fireBash,
	killedProbe,
	ok,
	restoreWarnings,
	warnings,
} from "./harness.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const DOC_PATH = join(ROOT, "docs", "extensions", "rtk.md");
const TEST_PATH_WIRING = ".pi/extensions/rtk/test/version-gate.test.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let savedDisabled: string | undefined;

beforeEach(() => {
	captureWarnings();
	savedDisabled = process.env.RTK_DISABLED;
	delete process.env.RTK_DISABLED;
});

afterEach(() => {
	restoreWarnings();
	if (savedDisabled === undefined) delete process.env.RTK_DISABLED;
	else process.env.RTK_DISABLED = savedDisabled;
});

// ---------------------------------------------------------------------------
// Phase 1: Factory is registration-only (no lifecycle I/O)
// ---------------------------------------------------------------------------


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
