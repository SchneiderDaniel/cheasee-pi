/**
 * Scrapling venv-setup adapter.
 *
 * Thin wrapper around shared ensureVenv utility with scrapling-specific config.
 * Keeps domain config (pip args, verify command) co-located in the scrapling
 * extension module.
 *
 * Two independent provisioning steps (issue #1986):
 *   1. ensureVenv — Python (create/pip/import verify). `verifyCommand` asserts
 *      imports ONLY; a browser miss here used to rm-rf a healthy venv.
 *   2. ensureStealthBrowser — the patchright-resolved chromium build (revision,
 *      cache root, writability, install, typed failure). Owned by browser-setup.ts.
 */

import { existsSync } from "node:fs";
import type { ExecFn } from "./types.ts";
import { ensureVenv } from "../lib/ensureVenv.ts";
import { ensureStealthBrowser, type EnsureBrowserOptions } from "./browser-setup.ts";

/**
 * Verify command: imports the stealth fetcher's dependencies. Success stays the
 * ensureVenv contract (exit 0 + stdout "ok"). The browser is deliberately NOT
 * asserted here — it is a separate gate, so a missing/mismatched chromium can no
 * longer fail this check and trigger an rm -rf + reinstall of the whole venv.
 */
const verifyCommand = [
	"from scrapling.fetchers import StealthyFetcher; import markdownify",
	"print('ok')",
].join("\n");

/**
 * Pip args, with the image's pinned-version contract appended when present.
 * `scrapling[fetchers]` floats patchright/playwright, so an unpinned install lets
 * build-time and runtime resolve different chromium revisions — the drift that
 * shipped a browser cache the runtime could never use. `-c` (not `-r`) keeps
 * these as ceilings: the requirement list still owns *what* gets installed.
 * Absent on dev machines → unchanged unpinned behaviour.
 */
function pipArgs(): string[] {
	const args = ["scrapling[fetchers]", "markdownify", "beautifulsoup4"];
	const constraints = process.env.SCRAPLING_PIP_CONSTRAINTS;
	if (constraints && existsSync(constraints)) args.push("-c", constraints);
	return args;
}

// ── ensureScraplingVenv ──

/**
 * Ensure Scrapling Python virtual environment exists and its stealth-tier
 * chromium build is installed.
 *
 * @param exec — Exec function (typically pi.exec)
 * @param cwd — Working directory (project root)
 * @param onUpdate — Optional progress update callback
 * @param browserOpts — Browser-provisioning overrides (test seam for cache root/writability)
 * @returns Path to python3 binary
 * @throws EnsureVenvError if venv creation or package installation fails
 * @throws EnsureBrowserError if the stealth-tier chromium build is unavailable
 */
export async function ensureScraplingVenv(
	exec: ExecFn,
	cwd: string,
	onUpdate?: (u: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void,
	browserOpts?: EnsureBrowserOptions,
): Promise<string> {
	const result = await ensureVenv({
		exec,
		cwd,
		venvName: ".pi/scrapling-venv",
		pipArgs: pipArgs(),
		verifyCommand,
		onUpdate,
	});

	await ensureStealthBrowser(result.pythonPath, exec, browserOpts);
	return result.pythonPath;
}
