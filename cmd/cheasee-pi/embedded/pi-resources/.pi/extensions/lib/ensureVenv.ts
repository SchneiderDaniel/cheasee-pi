/**
 * ensureVenv — shared Python virtual environment setup utility.
 *
 * Two-phase locking + two-phase critical section:
 *   1. Cross-process (file lock): proper-lockfile-based lock prevents parallel agent
 *      processes from corrupting the same venv. Stale lock detection via mtime with
 *      `onCompromised` warning handler instead of throw (defense-in-depth, see #1322).
 *   2. In-session (in-memory cache): retry cache prevents redundant re-creation
 *      within the same agent lifetime.
 *
 * Lock scope: held around the full mutation window (double-check → rm → create →
 * pip install → postInstall) and the final verify gate. Previously pip install ran
 * outside the lock (#1138), creating a race: concurrent callers would rm -rf the venv
 * mid-installation (the double-check used verifyCommand which checks the target
 * package before pip install ran). Moving pip install under the lock eliminates the
 * race. proper-lockfile's built-in mtime update (every stale/2 ms) keeps the lock
 * fresh during long pip install, and onCompromised handler warns instead of crash
 * (defense-in-depth, see #1322).
 *
 * Uses proper-lockfile for cross-process locking (atomic mkdir + periodic mtime update).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { ExecFn, OnUpdateCallback } from "./port-types.ts";

// ── Public Types ──

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
	 * Runs under the cross-process lock alongside create+pip install to prevent
	 * concurrent callers from rm-rf-ing the venv during setup.
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

interface RetryCacheEntry {
	ready: boolean;
	timestamp: number;
	retries: number;
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_RETRIES = 3;

const cache = new Map<string, RetryCacheEntry>();

function cacheKey(cwd: string, venvName: string): string {
	return `${cwd}::${venvName}`;
}

function cacheGet(key: string): { entry: RetryCacheEntry | undefined; shouldRetry: boolean } {
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
 *
 * @remarks
 * Any consumer of proper-lockfile MUST pass a custom `onCompromised` handler to
 * `lockfile.lock()`. The upstream default throws from inside a `setTimeout`
 * callback, which crashes the Node.js process with an uncaught exception
 * (#1136). This function provides a handler that logs a warning via `onUpdate`
 * instead of throwing. Future consumers that call `lockfile.lock()` directly
 * (bypassing this function) must replicate the same pattern.
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
			onCompromised: (err: Error) => {
				onUpdate?.({
					content: [{ type: "text", text: `Lock compromised: ${err.message}` }],
					details: { warning: true },
				});
			},
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

/**
 * Execute a function under the venv cross-process lock.
 * Acquires the lock, runs `fn`, releases the lock in `finally`.
 * The lock is guaranteed released even if `fn` throws.
 * The `onCompromised` handler warns via onUpdate instead of throwing
 * (defense-in-depth against fs.utimes failures in proper-lockfile's update timer).
 */
async function withLock<T>(
	onUpdate: OnUpdateCallback | undefined,
	lockFilePath: string,
	timeoutMs: number,
	staleMs: number,
	fn: () => Promise<T>,
): Promise<T> {
	const release = await acquireLock(lockFilePath, timeoutMs, staleMs, onUpdate);
	try {
		return await fn();
	} finally {
		await releaseLock(release, onUpdate);
	}
}

// ── ensureVenv ──

/**
 * Ensure a Python virtual environment exists with the specified packages.
 *
 * Flow:
 *   in-memory cache → quick verify →
 *   [withLock: acquire → double-check → rm → create → pip install → postInstall → release] →
 *   [withLock: acquire → verify → release] → cache success
 *
 * Lock held across create + pip install + postInstall to prevent concurrent
 * callers from rm-rf-ing the venv mid-installation. proper-lockfile's built-in
 * mtime update (every stale/2 ms) keeps the lock fresh during long pip I/O;
 * the onCompromised handler logs a warning instead of crashing (defense-in-depth).
 * In-session retry cache prevents redundant re-creation within the same agent lifetime.
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

	// ── 3-8. Full setup under lock: double-check, remove, create, install, postInstall ──
	// Lock held across the entire mutation to prevent concurrent callers from
	// rm-rf-ing the venv mid-installation. proper-lockfile's built-in mtime update
	// (every stale/2 ms) keeps the lock fresh; onCompromised warns instead of crash.
	const lockFilePath = lockFilePathFor(cwd, venvName);
	mkdirSync(join(cwd, ".pi"), { recursive: true });

	const created = await withLock(onUpdate, lockFilePath, lockTimeoutMs, lockStaleMs, async () => {
		// ── 4. Double-check after lock (another process may have set it up) ──
		{
			const recheck = await exec(pythonPath, ["-c", verifyCommand]);
			if (recheck.code === 0 && recheck.stdout.includes("ok")) {
				cacheMarkSuccess(ck);
				return false; // Signal: already set up — skip creation
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

		// ── 7. Install packages (under lock — prevents concurrent rm-rf race) ──
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

		// ── 8. Post-install hook (under lock) ──
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

		return true; // Signal: venv was freshly created and fully set up
	});

	// If double-check passed (another process set up the venv while we waited
	// for the lock), return early — no further work needed.
	if (!created) {
		return { pythonPath, created: false };
	}

	// ── 9. Verify under lock (re-acquired) ──
	await withLock(onUpdate, lockFilePath, lockTimeoutMs, lockStaleMs, async () => {
		const verifyResult = await exec(pythonPath, ["-c", verifyCommand]);
		if (verifyResult.code !== 0 || !verifyResult.stdout.includes("ok")) {
			cacheMarkFailure(ck);
			throw new EnsureVenvError(
				`Venv verification failed: ${verifyResult.stderr.slice(0, 500)}`,
				"verify",
				{ code: verifyResult.code, stderr: verifyResult.stderr },
			);
		}
	});

	cacheMarkSuccess(ck);
	return { pythonPath, created: true };
}
