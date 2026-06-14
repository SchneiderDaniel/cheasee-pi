/**
 * ensureVenv — shared Python virtual environment setup utility.
 *
 * Two-phase locking:
 *   1. Cross-process (file lock): atomic mkdir-based lock prevents parallel agent
 *      processes from corrupting the same venv. Stale lock detection via mtime.
 *   2. In-session (in-memory cache): retry cache prevents redundant re-creation
 *      within the same agent lifetime.
 *
 * No external dependencies — uses only node:fs, node:path.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

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

// ── Cross-process file lock (atomic mkdir) ──

function lockDirFor(cwd: string, venvName: string): string {
	const safe = venvName.replace(/[^a-zA-Z0-9_-]/g, "_");
	return join(cwd, ".pi", `ensureVenv.${safe}.lock`);
}

async function acquireLock(lockDir: string, timeoutMs: number, staleMs: number): Promise<void> {
	const startTime = Date.now();
	let attempt = 0;

	while (true) {
		attempt++;

		// Check for stale lock and remove it atomically-ish
		try {
			const stat = statSync(lockDir);
			if (Date.now() - stat.mtimeMs > staleMs) {
				try {
					rmSync(lockDir, { recursive: true, force: true });
				} catch {
					// Race: another agent cleaned it
				}
			}
		} catch {
			// Directory doesn't exist — proceed to acquire
		}

		// Try atomic mkdir (fails if directory already exists)
		try {
			mkdirSync(lockDir, { recursive: false });
			return; // Lock acquired
		} catch {
			// Directory exists — lock held by another process
		}

		if (Date.now() - startTime >= timeoutMs) {
			throw new EnsureVenvError(
				`Failed to acquire lock after ${attempt} attempts over ${timeoutMs}ms`,
				"lock",
			);
		}

		// Exponential backoff with jitter
		const base = Math.min(200 * Math.pow(2, attempt - 1), 1000);
		const jitter = Math.random() * 200;
		await new Promise((r) => setTimeout(r, base + jitter));
	}
}

function releaseLock(lockDir: string): void {
	try {
		rmSync(lockDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup
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
		lockTimeoutMs = 5000,
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
	const lockDir = lockDirFor(cwd, venvName);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	await acquireLock(lockDir, lockTimeoutMs, lockStaleMs);

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
		releaseLock(lockDir);
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
			releaseLock(lockDir);
		}
	}
}
