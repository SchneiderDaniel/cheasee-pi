/**
 * Scrapling stealth-tier browser provisioning.
 *
 * The stealth fetcher (StealthyFetcher) resolves its chromium build through
 * patchright's registry — a *specific* revision directory under the browser
 * cache — and the install must run with `python -m patchright install chromium`,
 * never playwright's (the two revision sets diverge).
 *
 * This module owns that contract and only that contract: revision resolution,
 * cache-root resolution, a writability probe, a presence check, the install, and
 * a typed failure. It is deliberately separate from ensureVenv (issue #1986):
 * a browser miss must not destroy a healthy Python venv, and a cache the agent
 * cannot write must fail in milliseconds — not after ~8 minutes of a doomed
 * download attempt.
 */

import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecFn } from "./types.ts";
import { isExecFailure } from "./types.ts";

// ── Public types ──

export interface EnsureBrowserOptions {
	/** Cache root override (default: PLAYWRIGHT_BROWSERS_PATH, else ~/.cache/ms-playwright). */
	cacheRoot?: string;
	/**
	 * Writability probe override. Inject in tests: under a root runner POSIX mode
	 * 0555 still passes access(W_OK), so the fail-fast path is not otherwise
	 * reachable deterministically.
	 */
	isWritable?: (path: string) => boolean;
}

/** Typed failure carrying the revision/cache contract the caller must surface. */
export class EnsureBrowserError extends Error {
	/** Chromium revision patchright resolves ("" when it could not be read). */
	readonly expectedRevision: string;
	/** Browser cache root the check ran against. */
	readonly cacheRoot: string;
	/** Whether the cache root was writable by this user. */
	readonly writable: boolean;

	constructor(
		message: string,
		details: { expectedRevision: string; cacheRoot: string; writable: boolean },
	) {
		super(message);
		this.name = "EnsureBrowserError";
		this.expectedRevision = details.expectedRevision;
		this.cacheRoot = details.cacheRoot;
		this.writable = details.writable;
	}
}

// ── Revision + cache root resolution ──

/**
 * Reads the chromium revision from patchright's own browsers.json. Never
 * hardcoded, so the check stays correct across version bumps; the driver layout
 * differs per platform, so the path is resolved by patchright itself.
 */
const REVISION_COMMAND = [
	"import json, pathlib, patchright",
	"d = json.loads((pathlib.Path(patchright.__file__).parent / 'driver/package/browsers.json').read_text())",
	"print(next(b['revision'] for b in d['browsers'] if b['name'] == 'chromium'))",
].join("\n");

/** Cache root: the image contract first, patchright's default second. */
export function resolveBrowserCacheRoot(
	env: Record<string, string | undefined> = process.env,
): string {
	return env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
}

/**
 * True when `path` (or its nearest existing ancestor, so a not-yet-created cache
 * directory is writable) accepts writes from this user.
 */
function defaultIsWritable(path: string): boolean {
	let dir = path;
	while (!existsSync(dir)) {
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
	try {
		accessSync(dir, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

// ── ensureStealthBrowser ──

/**
 * Ensure the chromium build patchright expects is present in the browser cache.
 *
 * Fail-fast contract: a missing build in a non-writable cache throws
 * {@link EnsureBrowserError} without spawning any install subprocess.
 *
 * @param pythonPath — venv python that owns the patchright install.
 * @param exec — Exec function (typically pi.exec).
 * @throws {EnsureBrowserError} when the revision cannot be resolved, the cache is
 *   not writable, or the install did not produce the expected build.
 */
export async function ensureStealthBrowser(
	pythonPath: string,
	exec: ExecFn,
	opts: EnsureBrowserOptions = {},
): Promise<void> {
	const cacheRoot = opts.cacheRoot ?? resolveBrowserCacheRoot();
	const isWritable = opts.isWritable ?? defaultIsWritable;

	const probe = await exec(pythonPath, ["-c", REVISION_COMMAND]);
	if (isExecFailure(probe)) {
		throw new EnsureBrowserError(
			`Could not resolve the patchright chromium revision from ${pythonPath}: ${(probe.stderr || probe.stdout).slice(0, 300)}`,
			{ expectedRevision: "", cacheRoot, writable: false },
		);
	}
	// Last non-empty line: a stray import warning on stdout must not shift the value.
	const expectedRevision = probe.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.pop();
	if (!expectedRevision || !/^\d+$/.test(expectedRevision)) {
		throw new EnsureBrowserError(
			`Unparseable patchright chromium revision "${probe.stdout.trim().slice(0, 200)}" from ${pythonPath}`,
			{ expectedRevision: "", cacheRoot, writable: false },
		);
	}

	const buildDir = join(cacheRoot, `chromium-${expectedRevision}`);
	if (existsSync(buildDir)) return;

	if (!isWritable(cacheRoot)) {
		throw new EnsureBrowserError(
			`Chromium ${expectedRevision} missing at ${buildDir} and ${cacheRoot} is not writable by this user, so 'python -m patchright install chromium' cannot self-heal. Rebuild the image with the pinned scrapling/patchright versions or point PLAYWRIGHT_BROWSERS_PATH at a writable cache.`,
			{ expectedRevision, cacheRoot, writable: false },
		);
	}

	// ~2m22s measured for the chromium download; the old 120s cap killed legit
	// installs mid-flight.
	const install = await exec(pythonPath, ["-m", "patchright", "install", "chromium"], {
		timeout: 600_000,
	});
	if (isExecFailure(install)) {
		throw new EnsureBrowserError(
			`patchright install chromium failed: ${(install.stderr || install.stdout).slice(0, 500)}`,
			{ expectedRevision, cacheRoot, writable: true },
		);
	}
	if (!existsSync(buildDir)) {
		throw new EnsureBrowserError(
			`patchright install chromium reported success but chromium-${expectedRevision} is still missing at ${buildDir}`,
			{ expectedRevision, cacheRoot, writable: true },
		);
	}
}
