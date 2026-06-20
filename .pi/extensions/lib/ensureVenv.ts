/**
 * ensureVenv — shared Python virtual environment setup utility.
 *
 * Two-phase locking:
 *   1. Cross-process (file lock): proper-lockfile-based lock prevents parallel agent
 *      processes from corrupting the same venv. Stale lock detection via mtime with
 *      active refresh during hold to prevent false staleness during long pip install.
 *   2. In-session (in-memory cache): retry cache prevents redundant re-creation
 *      within the same agent lifetime.
 *
 * Uses proper-lockfile for cross-process locking (atomic mkdir + periodic mtime update).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";

// ── Public Types ──

export interface ExecFn {
	(
		cmd: string,
		args: string[],
		opts?: { timeout?: number; signal?: AbortSignal },
	): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface OnUpdateCallback {
	(u: { content: Array<{ type: "text"; text: string }>; details: unknown }): void;
}

export interface EnsureVenvConfig {
	/** Exec function (typically pi.exec). */
	exec: ExecFn;
	/** Working directory (project root). */
	cwd: string;
	/** Venv directory name relative to cwd (e.g. ".pi/scrapling-venv"). */
	venvName: string;
	/** Pip install arguments (e.g. ["scrapling[fetchers]", "markdownify"]). */
	pipArgs: string[];
	/** Python command to verify successful import (e.g. "import ddgs; print('ok')"). */
	verifyCommand: string;
	/**
	 * Optional post-install hook called after pip install, before final return.
	 * Receives the resolved pythonPath.
	 * Runs under the cross-process lock, so keep it fast or increase lockStaleMs.
	 */
	postInstall?: (pythonPath: string) => Promise<void>;
	/** Max time to wait for cross-process lock in ms (default 5000). */
	lockTimeoutMs?: number;
	/** Lock staleness threshold in ms (default 30_000). */
	lockStaleMs?: number;
	/** Optional progress update callback. */
	onUpdate?: OnUpdateCallback;
}

export interface EnsureVenvResult {
	pythonPath: string;
	created: boolean;
}

/** Typed error with a discriminator so callers can surface exact failure context. */
export class EnsureVenvError extends Error {
	/** Which step of the venv setup failed. */
	step: "create" | "install" | "verify" | "lock";
	/** Optional execution result containing code and stderr. */
	execResult?: { code: number; stderr: string };

	constructor(
		message: string,
		step: "create" | "install" | "verify" | "lock",
		execResult?: { code: number; stderr: string },
	) {
		super(message);
		this.name = "EnsureVenvError";
		this.step = step;
		this.execResult = execResult;
	}
}

// ── In-memory retry cache ──

interface CacheEntry {
	ready: boolean;
	timestamp: number;
	retries: number;
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_RETRIES = 3;

const cache = new Map<string, CacheEntry>();

function cacheKey(cwd: string, venvName: string): string {
	return `${cwd}::${venvName}`;
}

function cacheGet(key: string): { entry: CacheEntry | undefined; shouldRetry: boolean } {
	const entry = cache.get(key);
	if (!entry) return { entry: undefined, shouldRetry: false };
	if (entry.ready) return { entry, shouldRetry: false };
	if (entry.retries >= CACHE_MAX_RETRIES) return { entry, shouldRetry: false };
	if (Date.now() - entry.timestamp < CACHE_TTL_MS) return { entry, shouldRetry: false };
	return { entry, shouldRetry: true };
}

function cacheMarkSuccess(key: string): void {
	cache.set(key, { ready: true, timestamp: Date.now(), retries: 0 });
}

function cacheMarkFailure(key: string): void {
	const existing = cache.get(key);
	const retries = existing ? existing.retries + 1 : 0;
	cache.set(key, { ready: false, timestamp: Date.now(), retries });
}

// ── Cross-process file lock (proper-lockfile) ──

/**
 * Compute the base lock path (without .lock suffix — proper-lockfile appends it).
 * E.g., for venvName ".pi/web-search-venv", returns `/path/to/.pi/ensureVenv.web-search-venv`
 * and proper-lockfile creates `/path/to/.pi/ensureVenv.web-search-venv.lock`.
 */
function lockFilePathFor(cwd: string, venvName: string): string {
	const safe = venvName.replace(/[^a-zA-Z0-9_-]/g, "_");
	return join(cwd, ".pi", `ensureVenv.${safe}`);
}

/**
 * Acquire a cross-process lock using proper-lockfile.
 *
 * @param lockFilePath — Base path without .lock (proper-lockfile appends .lock)
 * @param timeoutMs — Approximate time budget for retries before throwing
 * @param staleMs — Staleness threshold in ms (proper-lockfile enforces minimum 2000)
 * @param onUpdate — Optional callback for structured logging
 * @returns Release function (call to release the lock)
 * @throws EnsureVenvError with step='lock' if lock cannot be acquired
 */
async function acquireLock(
	lockFilePath: string,
	timeoutMs: number,
	staleMs: number,
	onUpdate?: OnUpdateCallback,
): Promise<() => Promise<void>> {
	const pid = process.pid;
	const startTime = Date.now();

	onUpdate?.({
		content: [{ type: "text", text: `Acquiring venv lock (pid=${pid})…` }],
		details: {},
	});

	// Map timeout to proper-lockfile retry options.
	// Retry count: target ~1 retry per 1000ms of timeout, cap at 120.
	const retryCount = Math.min(120, Math.max(5, Math.ceil(timeoutMs / 1000)));
	const retryOpts = {
		retries: retryCount,
		factor: 2,
		minTimeout: 200,
		maxTimeout: 1000,
		randomize: true,
	};

	try {
		const release = await lockfile.lock(lockFilePath, {
			stale: staleMs,
			retries: retryOpts,
			realpath: false,
		});

		const waitMs = Date.now() - startTime;
		onUpdate?.({
			content: [{ type: "text", text: `Lock acquired after ${waitMs}ms (pid=${pid})` }],
			details: {},
		});

		return release;
	} catch (err: unknown) {
		const elapsed = Date.now() - startTime;
		const msg = err instanceof Error ? err.message : String(err);
		throw new EnsureVenvError(`Failed to acquire lock after ${elapsed}ms: ${msg}`, "lock");
	}
}

/**
 * Release a cross-process lock obtained via acquireLock.
 */
async function releaseLock(
	release: () => Promise<void>,
	onUpdate?: OnUpdateCallback,
): Promise<void> {
	const pid = process.pid;
	onUpdate?.({
		content: [{ type: "text", text: `Releasing venv lock (pid=${pid})…` }],
		details: {},
	});

	try {
		await release();
	} catch {
		// Best-effort cleanup — lock may already be released or compromised
	}
}

// ── ensureVenv ──

/**
 * Ensure a Python virtual environment exists with the specified packages.
 *
 * Flow:
 *   in-memory cache → quick verify → acquire file lock → double-check →
 *   create venv → pip install → postInstall → verify → cache success
 *
 * Two-phase locking prevents both cross-process races (file lock) and
 * in-session redundant work (retry cache).
 *
 * @returns `{ pythonPath, created }` — `created` is true when a fresh venv was set up.
 * @throws {EnsureVenvError} on failure, with a `step` discriminator.
 */
export async function ensureVenv(config: EnsureVenvConfig): Promise<EnsureVenvResult> {
	const {
		exec,
		cwd,
		venvName,
		pipArgs,
		verifyCommand,
		postInstall,
		lockTimeoutMs = 60_000,
		lockStaleMs = 30_000,
		onUpdate,
	} = config;

	const venvDir = join(cwd, venvName);
	const pythonPath = join(venvDir, "bin", "python3");
	const ck = cacheKey(cwd, venvName);

	// ── 1. In-memory cache check ──
	{
		const { entry, shouldRetry } = cacheGet(ck);
		if (entry && !shouldRetry) {
			if (entry.ready) {
				return { pythonPath, created: false };
			}
			throw new EnsureVenvError(
				`Venv setup previously failed after ${entry.retries} attempts`,
				"install",
			);
		}
	}

	// ── 2. Quick verify check ──
	{
		const check = await exec(pythonPath, ["-c", verifyCommand]);
		if (check.code === 0 && check.stdout.includes("ok")) {
			cacheMarkSuccess(ck);
			return { pythonPath, created: false };
		}
	}

	// ── 3. Cross-process lock ──
	const lockFilePath = lockFilePathFor(cwd, venvName);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const release = await acquireLock(lockFilePath, lockTimeoutMs, lockStaleMs, onUpdate);

	let lockReleased = false;
	try {
		// ── 4. Double-check after lock (another process may have set it up) ──
		{
			const recheck = await exec(pythonPath, ["-c", verifyCommand]);
			if (recheck.code === 0 && recheck.stdout.includes("ok")) {
				cacheMarkSuccess(ck);
				return { pythonPath, created: false };
			}
		}

		// ── 5. Remove broken venv ──
		await exec("rm", ["-rf", venvDir]);

		// ── 6. Create venv ──
		onUpdate?.({
			content: [{ type: "text", text: "Creating Python virtual environment…" }],
			details: {},
		});

		const createResult = await exec("python3", ["-m", "venv", "--clear", venvDir]);
		if (createResult.code !== 0) {
			cacheMarkFailure(ck);
			throw new EnsureVenvError(
				`Failed to create virtual environment: ${createResult.stderr}`,
				"create",
				{ code: createResult.code, stderr: createResult.stderr },
			);
		}

		// ── 7. Install packages ──
		if (pipArgs.length > 0) {
			onUpdate?.({
				content: [{ type: "text", text: "Installing packages…" }],
				details: {},
			});

			const installResult = await exec(pythonPath, ["-m", "pip", "install", ...pipArgs], {
				timeout: 180_000,
			});
			if (installResult.code !== 0) {
				cacheMarkFailure(ck);
				throw new EnsureVenvError(
					`Failed to install packages: ${installResult.stderr.slice(0, 500)}`,
					"install",
					{ code: installResult.code, stderr: installResult.stderr },
				);
			}
		}

		// Release lock before postInstall so slow downloads don't block other agents
		await releaseLock(release, onUpdate);
		lockReleased = true;

		// ── 8. Post-install hook ──
		if (postInstall) {
			onUpdate?.({
				content: [{ type: "text", text: "Running post-install steps…" }],
				details: {},
			});
			try {
				await postInstall(pythonPath);
			} catch (err) {
				cacheMarkFailure(ck);
				throw err instanceof EnsureVenvError
					? err
					: new EnsureVenvError(`Post-install step failed: ${(err as Error).message}`, "install");
			}
		}

		// ── 9. Verify ──
		const verifyResult = await exec(pythonPath, ["-c", verifyCommand]);
		if (verifyResult.code !== 0 || !verifyResult.stdout.includes("ok")) {
			cacheMarkFailure(ck);
			throw new EnsureVenvError(
				`Venv verification failed: ${verifyResult.stderr.slice(0, 500)}`,
				"verify",
				{ code: verifyResult.code, stderr: verifyResult.stderr },
			);
		}

		cacheMarkSuccess(ck);
		return { pythonPath, created: true };
	} finally {
		if (!lockReleased) {
			await releaseLock(release, onUpdate);
		}
	}
}
