// ─── Worktree Lifecycle ──────────────────────────────────────────
// Worktree create/cleanup/install-deps using pi.exec.
// Supervisor-owned: creates before agent dispatch, cleans up after pipeline.
// All functions return Result<T> for explicit failure handling.

import type { ExtensionAPI, ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import {
	accessSync,
	constants as fsConstants,
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve as resolvePath,
	sep,
} from "node:path";
import { getDebugLogger } from "../lib/debug.ts";
import { withNotify, type Result } from "./result.ts";
import type { NotifyFn } from "./helpers.ts";

// ─── Create Worktree ─────────────────────────────────────────────

// ─── Exec Contract Normalization ─────────────────────────────────
// pi.exec resolves {code} even on non-zero exit — it never rejects. Some
// mocks/tests reject instead. Normalize both contracts so callers can check
// `.code` unconditionally; a silent success lets a failed worktree command
// pass as ok (the broken fallback that produced the "Worktree missing"
// cascade when `git worktree add` failed on an unwritable base dir).
async function execChecked(
	pi: ExtensionAPI,
	cmd: string,
	args: string[],
	opts?: ExecOptions,
): Promise<ExecResult> {
	try {
		return await pi.exec(cmd, args, opts);
	} catch (err: unknown) {
		return {
			code: 1,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
			killed: false,
		};
	}
}

/**
 * Reconcile the worktree branch to match the remote tracking branch if one exists.
 *
 * When a worktree is recreated after pipeline cleanup (local branch deleted but
 * remote branch persists), the new local branch may be at defaultBranch HEAD while
 * the remote tracking branch has the developer's actual commits. This function
 * detects that scenario and resets the worktree to match its remote counterpart.
 *
 * Returns Result<void> — never throws. On failure, the caller decides whether
 * reconciliation is fatal (createWorktree treats it as fatal).
 */
export async function reconcileToRemoteBranch(
	pi: ExtensionAPI,
	cwd: string,
	wtPath: string,
	worktreeBranch: string,
	remote: string,
	notify: NotifyFn,
): Promise<Result<void>> {
	const log = getDebugLogger();
	const remoteRef = `refs/remotes/${remote}/${worktreeBranch}`;

	// Check if remote tracking branch exists. The old try/catch-only guard
	// never fired (pi.exec doesn't reject on non-zero exit) — a missing ref
	// was treated as "exists" and fetch/reset ran against a possibly
	// nonexistent worktree.
	const revParse = await execChecked(pi, "git", ["rev-parse", "--verify", remoteRef], {
		cwd,
		timeout: 10000,
	});
	if (revParse.code !== 0) {
		log.info(
			"worktree",
			`No remote tracking branch ${remote}/${worktreeBranch} — skipping reconciliation`,
		);
		return { ok: true, value: undefined };
	}

	log.info("worktree", `Remote tracking branch ${remote}/${worktreeBranch} exists — reconciling`);

	const fetchRes = await execChecked(pi, "git", ["fetch", remote, worktreeBranch], {
		cwd,
		timeout: 30000,
	});
	if (fetchRes.code !== 0) {
		const msg =
			`git fetch ${remote} ${worktreeBranch} failed: ${fetchRes.stderr || fetchRes.stdout}`.trim();
		log.error("worktree", msg);
		return { ok: false, error: msg, source: "worktree" };
	}

	const resetRes = await execChecked(
		pi,
		"git",
		["reset", "--hard", `${remote}/${worktreeBranch}`],
		{ cwd: wtPath, timeout: 15000 },
	);
	if (resetRes.code !== 0) {
		const msg =
			`git reset --hard ${remote}/${worktreeBranch} failed: ${resetRes.stderr || resetRes.stdout}`.trim();
		log.error("worktree", msg);
		return { ok: false, error: msg, source: "worktree" };
	}

	log.info("worktree", `Worktree reconciled to ${remote}/${worktreeBranch}`);
	notify.info(`Reconciled worktree to remote branch ${remote}/${worktreeBranch}`);
	return { ok: true, value: undefined };
}

/**
 * Resolve the worktree base directory, falling back to a writable location.
 *
 * The configured base (default "../") resolves against the repo cwd and is
 * used as-is when writable or creatable. In the docker deployment the parent
 * of the repo mount (/workspaces) is an image-owned overlay (root:root 755),
 * so `git worktree add` fails with "Permission denied" and the whole pipeline
 * aborts. Probe writability up front and fall back to
 * os.tmpdir()/cheasee-pi-worktrees — the pipeline runs instead of dying.
 *
 * Deterministic: same cwd + configured base + fs state always yields the same
 * result, so the stale-state scanner can re-derive the base the worktree was
 * actually created under.
 */
export function resolveWorktreeBase(
	cwd: string,
	configuredBase: string,
	notify?: NotifyFn,
): string {
	const log = getDebugLogger();
	const base = resolvePath(cwd, configuredBase);
	if (isWritableOrCreatable(base)) {
		return base;
	}
	const fallback = join(tmpdir(), "cheasee-pi-worktrees");
	log.warn("worktree", `Worktree base ${base} is not writable — falling back to ${fallback}`);
	notify?.info(`Worktree base ${base} not writable — using ${fallback} for this pipeline`);
	try {
		mkdirSync(fallback, { recursive: true });
	} catch (err) {
		throw new Error(
			`Worktree base ${base} is not writable and fallback ${fallback} could not be created: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	return fallback;
}

// W_OK on the path itself. Only missing paths (ENOENT) walk up to the
// nearest existing ancestor — git worktree add creates leading dirs, so a
// writable ancestor is enough for those. An existing-but-unwritable dir
// (EACCES, e.g. /workspaces root:root 755) is a hard no: creation inside it
// fails, so the caller must fall back.
function isWritableOrCreatable(path: string): boolean {
	try {
		accessSync(path, fsConstants.W_OK);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			const parent = dirname(path);
			if (parent === path) {
				return false;
			}
			return isWritableOrCreatable(parent);
		}
		return false;
	}
}

/**
 * Recover a stale worktree registration before creating a new worktree.
 *
 * A crashed pipeline can leave a registration in .bare/worktrees/<branch>/ with
 * its worktree dir already removed (crash cleanup deleted the dir but not the
 * registration). The entrypoint locks every registration, and `git worktree
 * prune` skips locked entries — so the stale registration blocks BOTH add
 * attempts ("already checked out") and the prune that would fix it. Unlock +
 * prune first, then the normal create flow re-adds cleanly.
 *
 * Never throws. Returns void — failures are logged and the create flow simply
 * runs against the stale state (its own error path reports the failure).
 */
export async function recoverStaleWorktreeRegistration(
	pi: ExtensionAPI,
	cwd: string,
	worktreeBase: string,
	worktreeBranch: string,
): Promise<void> {
	const log = getDebugLogger();
	const base = resolveWorktreeBase(cwd, worktreeBase);
	const wt = resolvePath(base, worktreeBranch);

	// Only recover when the registration exists but the dir is gone — a live
	// worktree (dir present) must never be pruned out from under a pipeline.
	if (existsSync(wt)) {
		return;
	}

	// Locate the bare repo's admin dir: .bare/worktrees/<branch>/
	const commonDir = await execChecked(pi, "git", ["rev-parse", "--git-common-dir"], {
		cwd,
		timeout: 10000,
	});
	if (commonDir.code !== 0) {
		log.warn("worktree", "Could not resolve git common dir — skipping stale registration recovery");
		return;
	}
	const bareWorktrees = join(commonDir.stdout.trim(), "worktrees");
	const regDir = join(bareWorktrees, worktreeBranch);
	if (!existsSync(regDir)) {
		return; // no stale registration to recover
	}

	log.warn("worktree", `Stale registration ${regDir} (worktree dir missing) — unlocking + pruning`);

	// Remove the lock so prune can drop the dead registration.
	const lockFile = join(regDir, "locked");
	if (existsSync(lockFile)) {
		const unlock = await execChecked(pi, "rm", ["-f", lockFile], { timeout: 5000 });
		if (unlock.code !== 0) {
			log.warn("worktree", `Failed to remove lock file ${lockFile}: ${unlock.stderr}`);
			return;
		}
	}

	const prune = await execChecked(pi, "git", ["worktree", "prune"], { cwd, timeout: 15000 });
	if (prune.code !== 0) {
		log.warn("worktree", `git worktree prune failed during recovery: ${prune.stderr}`);
	}
}

export async function createWorktree(
	pi: ExtensionAPI,
	cwd: string,
	worktreeBase: string,
	worktreeBranch: string,
	defaultBranch: string,
	notify: NotifyFn,
): Promise<Result<string>> {
	return withNotify(
		async () => {
			const log = getDebugLogger();
			const base = resolveWorktreeBase(cwd, worktreeBase, notify);
			const wt = resolvePath(base, worktreeBranch);
			log.info("worktree", `Creating worktree: ${wt}`);

			// Recover a stale registration left by a crashed run BEFORE the add
			// attempts — otherwise both fail with "already checked out" while
			// the entrypoint's lock blocks the prune that would fix it.
			await recoverStaleWorktreeRegistration(pi, cwd, worktreeBase, worktreeBranch);

			// Attempt 1: git worktree add -b (creates new branch + worktree)
			try {
				const result = await pi.exec(
					"git",
					["worktree", "add", "-b", worktreeBranch, wt, defaultBranch],
					{ cwd, timeout: 15000 },
				);
				if (result.code !== 0) {
					throw new Error(result.stderr || result.stdout || "git worktree add failed");
				}
				log.info("worktree", `Worktree created at ${wt}`);

				// Reconcile to remote tracking branch if one exists
				const reconcile = await reconcileToRemoteBranch(
					pi,
					cwd,
					wt,
					worktreeBranch,
					"origin",
					notify,
				);
				if (!reconcile.ok) {
					throw new Error(`Reconciliation failed: ${reconcile.error}`);
				}

				return wt;
			} catch (err: unknown) {
				const attempt1Err = err instanceof Error ? err.message : String(err);
				log.warn("worktree", `Attempt 1 failed: ${attempt1Err}`);
			}

			// Attempt 2: branch already exists — try add without -b
			try {
				const result = await pi.exec("git", ["worktree", "add", wt, worktreeBranch], {
					cwd,
					timeout: 15000,
				});
				if (result.code !== 0) {
					throw new Error(result.stderr || result.stdout || "git worktree add failed");
				}
				log.info("worktree", `Worktree attached at ${wt} (existing branch ${worktreeBranch})`);

				// Reconcile to remote tracking branch if one exists
				const reconcile = await reconcileToRemoteBranch(
					pi,
					cwd,
					wt,
					worktreeBranch,
					"origin",
					notify,
				);
				if (!reconcile.ok) {
					throw new Error(`Reconciliation failed: ${reconcile.error}`);
				}

				return wt;
			} catch (err2: unknown) {
				const attempt2Err = err2 instanceof Error ? err2.message : String(err2);
				log.warn("worktree", `Attempt 2 failed: ${attempt2Err}`);
			}

			// Both attempts failed — check if worktree dir somehow exists.
			// Check result.code explicitly: pi.exec resolves {code} on non-zero
			// exit (never rejects), so the old try/catch treated a missing dir
			// as "exists" and the pipeline ran against a nonexistent worktree.
			const testRes = await execChecked(pi, "test", ["-d", wt], { timeout: 5000 });
			if (testRes.code !== 0) {
				const msg = `Failed to create worktree at ${wt} after 2 attempts`;
				log.error("worktree", msg);
				throw new Error(msg);
			}
			log.warn("worktree", "Both attempts failed but worktree dir exists — using it");

			// Reconcile to remote tracking branch if one exists
			const reconcile = await reconcileToRemoteBranch(
				pi,
				cwd,
				wt,
				worktreeBranch,
				"origin",
				notify,
			);
			if (!reconcile.ok) {
				throw new Error(`Reconciliation failed: ${reconcile.error}`);
			}

			return wt;
		},
		notify,
		"worktree",
	);
}

// ponytail: copy git-ignored host dirs into worktree so extensions that depend
// on git-managed packages (ponytail hooks, etc.) can load, and the maintainer's
// host-side private-pi clone is available to agents. `.pi/git/` and `private-pi/`
// are in .gitignore — git worktree add doesn't copy them.
async function copyHostDirs(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	notify: NotifyFn,
): Promise<void> {
	const log = getDebugLogger();
	const dirs: Array<[string, string]> = [
		[resolvePath(cwd, ".pi/git"), resolvePath(worktreePath, ".pi/git")],
	];
	const privatePiSrc = resolvePath(cwd, "private-pi");
	if (existsSync(privatePiSrc)) {
		dirs.push([privatePiSrc, resolvePath(worktreePath, "private-pi")]);
	}
	for (const [src, dst] of dirs) {
		const cpRes = await execChecked(pi, "cp", ["-r", "--preserve=links", src, dst], {
			timeout: 30_000,
		});
		if (cpRes.code !== 0) {
			const msg = cpRes.stderr || cpRes.stdout || "cp failed";
			log.warn("worktree", `Failed to copy ${src}: ${msg} — continuing without`);
		} else {
			log.info("worktree", `Copied ${src} to ${dst}`);
		}
	}

	await linkWorktreeVenvs(cwd, worktreePath);
}

/**
 * Link the main repo's prebuilt web_search/web_crawl venvs into a worktree.
 *
 * Worktrees start without `.pi/scrapling-venv` / `.pi/web-search-venv`, so the
 * first web_crawl call in a subagent triggered a FULL fresh build: pip install
 * of scrapling[fetchers] over the flaky container network died mid-download,
 * and ensureVenv's in-memory retry cache then rejected every later call with
 * "Venv setup previously failed after N attempts" (0.0s instant failures).
 *
 * Symlink (not copy): venvs are hundreds of MB and the prebuilt copies already
 * exist in main's `.pi`. ensureVenv's `rm -rf` on a symlink removes only the
 * link, so a broken venv still rebuilds in place at the worktree.
 */
export async function linkWorktreeVenvs(cwd: string, worktreePath: string): Promise<void> {
	const log = getDebugLogger();
	const venvLinks: Array<[string, string]> = [
		[resolvePath(cwd, ".pi/scrapling-venv"), resolvePath(worktreePath, ".pi/scrapling-venv")],
		[resolvePath(cwd, ".pi/web-search-venv"), resolvePath(worktreePath, ".pi/web-search-venv")],
	];
	for (const [src, dst] of venvLinks) {
		if (!existsSync(src)) {
			continue; // no prebuilt venv (bare dev machine) — ensureVenv builds fresh
		}
		mkdirSync(dirname(dst), { recursive: true });
		try {
			rmSync(dst, { force: true, recursive: true }); // stale dir/link from a previous run
			symlinkSync(relative(dirname(dst), src), dst, "dir");
			log.info("worktree", `Linked ${src} -> ${dst}`);
		} catch (err) {
			log.warn(
				"worktree",
				`Failed to link venv ${src}: ${(err as Error).message} — continuing without`,
			);
		}
	}
}

// ─── Install Worktree Dependencies ───────────────────────────────

export async function installWorktreeDeps(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	notify: NotifyFn,
): Promise<Result<void>> {
	await copyHostDirs(pi, cwd, worktreePath, notify);

	return withNotify(
		async () => {
			const log = getDebugLogger();
			log.info("worktree", `Installing deps at ${worktreePath}`);

			// Attempt 1 — check result.code explicitly (pi.exec never rejects
			// on non-zero exit; the old try/catch logged "npm ci OK" even when
			// npm failed, e.g. package.json missing in a non-worktree dir).
			const first = await execChecked(pi, "npm", ["ci"], { cwd: worktreePath, timeout: 120_000 });
			if (first.code === 0) {
				log.info("worktree", "npm ci OK");
				return;
			}
			const firstMsg = (first.stderr || first.stdout || "npm ci failed").trim();
			log.warn("worktree", `npm ci failed (attempt 1): ${firstMsg}`);

			// Retry once for transient failures (e.g., network flake, registry timeout)
			const retry = await execChecked(pi, "npm", ["ci"], { cwd: worktreePath, timeout: 120_000 });
			if (retry.code === 0) {
				log.info("worktree", "npm ci OK on retry");
				return;
			}
			const retryMsg = (retry.stderr || retry.stdout || "npm ci failed").trim();
			log.warn("worktree", `npm ci failed (attempt 2): ${retryMsg}`);

			// Both attempts failed — throw to trigger Result failure
			throw new Error(
				`npm ci failed at ${worktreePath} after 2 attempts — continuing with potentially missing dependencies: ${retryMsg}`,
			);
		},
		notify,
		"worktree",
	);
}

// ─── Worktree Removal Guard ──────────────────────────────────────
// cleanupStalePipelineState drives `rm -rf` from a repo-local JSON state
// file, so `state.worktreePath` is untrusted input: any code that can write
// `.pi/supervisor-state-*.json` could name `/workspaces/main` and delete the
// main checkout. A worktree path may only be removed when it is (a) inside
// the worktree base after full symlink canonicalization and (b) a registered
// linked worktree. Fail closed: anything that cannot be verified is skipped.

export interface WorktreeEntry {
	path: string;
	bare: boolean;
	prunable: boolean;
	locked: boolean;
	detached: boolean;
	/** `refs/heads/<name>`, or null when bare / detached. */
	branch: string | null;
}

/**
 * A worktree the guard proved removable, with the branch it is actually
 * registered on — see `verifyRemovableWorktree`.
 */
export interface VerifiedWorktree {
	/** Canonical absolute path safe to delete. */
	path: string;
	/**
	 * `refs/heads/<name>` the matched worktree carries, or null when the entry
	 * is bare/detached. The caller must not delete a branch for a null — the
	 * branch name in the state file is untrusted and must match this identity.
	 */
	branch: string | null;
}

/**
 * Parse `git worktree list --porcelain -z` output.
 *
 * `-z` is required: each field is NUL-terminated and records are separated by
 * an extra NUL, so a worktree path containing a newline survives as one entry.
 * Splitting on newlines instead would split such a path in two.
 */
export function parseWorktreeListPorcelain(stdout: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;
	for (const token of stdout.split("\0")) {
		if (token.trim() === "") {
			continue; // record separator / trailing NUL
		}
		if (token.startsWith("worktree ")) {
			if (current) {
				entries.push(current);
			}
			current = {
				path: token.slice("worktree ".length),
				bare: false,
				prunable: false,
				locked: false,
				detached: false,
				branch: null,
			};
			continue;
		}
		if (!current) {
			continue; // attribute before any `worktree` line — ignore
		}
		if (token === "bare") {
			current.bare = true;
		} else if (token === "detached") {
			current.detached = true;
		} else if (token === "locked" || token.startsWith("locked ")) {
			current.locked = true;
		} else if (token === "prunable" || token.startsWith("prunable ")) {
			current.prunable = true;
		} else if (token.startsWith("branch ")) {
			current.branch = token.slice("branch ".length);
		}
	}
	if (current) {
		entries.push(current);
	}
	return entries;
}

/**
 * Canonicalize a path: resolve `./`, `../` and every symlink.
 *
 * A missing leaf is allowed (a stale worktree dir may already be gone): its
 * parent is canonicalized and the basename re-attached, so symlinked
 * intermediate components still resolve to their real target — a plain
 * string/abspath check would let a symlink under the base point outside it.
 *
 * @returns the canonical absolute path, or `null` when it cannot be resolved.
 */
export function canonicalizePath(p: string): string | null {
	const abs = resolvePath(p);
	try {
		return realpathSync(abs);
	} catch {
		// Leaf does not exist — fall through to parent resolution
	}
	const parent = dirname(abs);
	if (parent === abs) {
		return null;
	}
	try {
		return join(realpathSync(parent), basename(abs));
	} catch {
		return null;
	}
}

/**
 * Strict containment: true only for a proper descendant of `base`.
 *
 * `candidate === base` returns false — removing the whole worktree base would
 * delete every sibling worktree. The separator-suffixed compare rejects
 * `base-evil` siblings that a bare `startsWith(base)` would accept.
 */
export function isStrictlyInside(base: string, candidate: string): boolean {
	const b = resolvePath(base);
	const c = resolvePath(candidate);
	if (c === b) {
		return false;
	}
	const prefix = b.endsWith(sep) ? b : b + sep;
	return c.startsWith(prefix);
}

/**
 * Fetch the linked-worktree allowlist. Fails closed: a git error or an empty
 * listing yields ok=false, and callers must treat that as "remove nothing".
 */
export async function fetchWorktreeAllowlist(
	pi: ExtensionAPI,
	cwd: string,
): Promise<Result<WorktreeEntry[]>> {
	const res = await execChecked(pi, "git", ["worktree", "list", "--porcelain", "-z"], {
		cwd,
		timeout: 15000,
	});
	if (res.code !== 0) {
		return {
			ok: false,
			error: res.stderr || res.stdout || "git worktree list failed",
			source: "worktree",
		};
	}
	const entries = parseWorktreeListPorcelain(res.stdout);
	if (entries.length === 0) {
		return { ok: false, error: "git worktree list returned no worktrees", source: "worktree" };
	}
	return { ok: true, value: entries };
}

/**
 * Decide whether `candidate` may be removed. Returns the canonical path to
 * remove plus the branch the matched worktree actually carries, or an error
 * describing why removal was refused.
 *
 * Every refusal is deliberate and fail-closed; the caller must skip all
 * destructive steps (worktree remove, branch delete, rm) and leave the state
 * file in place for manual cleanup. The returned branch is the *verified*
 * identity — the branch named by the untrusted state file is only safe to
 * delete when it matches it.
 */
export function verifyRemovableWorktree(
	entries: WorktreeEntry[],
	cwd: string,
	baseDir: string,
	candidate: string,
	defaultBranch?: string | null,
): Result<VerifiedWorktree> {
	const reject = (why: string): Result<VerifiedWorktree> => ({
		ok: false,
		error: why,
		source: "worktree",
	});

	const canonicalBase = canonicalizePath(baseDir);
	if (!canonicalBase) {
		return reject(`worktree base ${baseDir} cannot be resolved`);
	}

	// Resolve relative candidates against `cwd` (the repo root this run was
	// invoked with) — never process.cwd(), which is unrelated to the repo.
	const canonicalCandidate = canonicalizePath(resolvePath(cwd, candidate));
	if (!canonicalCandidate) {
		return reject(`worktreePath ${candidate} cannot be resolved`);
	}
	if (!isStrictlyInside(canonicalBase, canonicalCandidate)) {
		return reject(`worktreePath ${candidate} is outside worktree base ${canonicalBase}`);
	}

	// Never the checkout the supervisor itself runs from.
	const canonicalCwd = canonicalizePath(cwd);
	if (canonicalCwd && canonicalCwd === canonicalCandidate) {
		return reject(`worktreePath ${candidate} is the main repository root`);
	}

	if (entries.length === 0) {
		return reject("no registered worktrees to verify against");
	}

	// `git worktree list` prints the raw admin `gitdir` file content. When that
	// file holds a relative path (`../../../main/.git`, as the docker worktree
	// bootstrap writes it) git resolves it against the worktree's own admin dir,
	// not against cwd — so resolve relative entries the same way. Absolute
	// entries (normal git) ignore the base entirely.
	// `worktree list` prints the main worktree first; for a bare repo that entry
	// is the bare dir, which is where the `worktrees/` admin dir lives.
	const adminRoot = entries[0].bare ? join(entries[0].path, "worktrees") : null;

	let matched: WorktreeEntry | null = null;
	for (const entry of entries) {
		const resolved = isAbsolute(entry.path)
			? canonicalizePath(entry.path)
			: canonicalizePath(
					resolvePath(adminRoot ? join(adminRoot, basename(entry.path)) : cwd, entry.path),
				);
		if (resolved !== null && resolved === canonicalCandidate) {
			matched = entry;
			break;
		}
	}
	if (!matched) {
		return reject(`worktreePath ${candidate} is not a registered worktree`);
	}
	if (matched.bare) {
		return reject(`worktreePath ${candidate} is a bare repository`);
	}
	if (matched === entries[0]) {
		return reject(`worktreePath ${candidate} is the main worktree`);
	}
	// The checkout carrying the default branch is the repository the pipeline
	// runs against. `git worktree remove` will not remove the main worktree,
	// but in a bare+linked layout (`--bare` + sibling checkouts) the main
	// checkout is an ordinary linked entry and is listed as such — the branch
	// it carries is the only layout-independent way to recognise it.
	if (defaultBranch && matched.branch === `refs/heads/${defaultBranch}`) {
		return reject(`worktreePath ${candidate} carries the default branch ${defaultBranch}`);
	}

	return { ok: true, value: { path: canonicalCandidate, branch: matched.branch } };
}

// ─── Delete Branch ───────────────────────────────────────────────

/**
 * Deletes a git branch via `git branch -D`.
 * Extracted from cleanupWorktree so crash-cleanup can run this
 * before the timeout race, preventing orphaned branches.
 * Returns Result<void> — never throws.
 */
export async function deleteBranch(
	pi: ExtensionAPI,
	cwd: string,
	worktreeBranch: string,
): Promise<Result<void>> {
	const delRes = await execChecked(pi, "git", ["branch", "-D", worktreeBranch], {
		cwd,
		timeout: 10000,
	});
	if (delRes.code !== 0) {
		const msg = delRes.stderr || delRes.stdout || `git branch -D ${worktreeBranch} failed`;
		return { ok: false, error: msg, source: "worktree" };
	}
	return { ok: true, value: undefined };
}

// ─── Cleanup Worktree ────────────────────────────────────────────

/**
 * Removes a git worktree and optionally deletes its branch.
 *
 * When `skipBranch` is true, skips `git branch -D` — use when the
 * branch was already deleted via deleteBranch() before the race.
 * Defaults to false for backward compatibility with handler.ts.
 */
export async function cleanupWorktree(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	worktreeBranch: string,
	notify: NotifyFn,
	skipBranch?: boolean,
): Promise<Result<void>> {
	return withNotify(
		async () => {
			const log = getDebugLogger();
			log.info("worktree", `Cleaning up worktree: ${worktreePath}, branch: ${worktreeBranch}`);
			// Check result.code explicitly — pi.exec resolves {code} on non-zero
			// exit (never rejects), so failures surface instead of logging
			// "removed" unconditionally.
			// Double --force: git refuses to remove a locked worktree with a
			// single --force (entrypoint.sh locks every worktree registration).
			// The lock only protects against prune; we own this worktree.
			const removeRes = await execChecked(
				pi,
				"git",
				["worktree", "remove", "--force", "--force", worktreePath],
				{
					cwd,
					timeout: 15000,
				},
			);
			if (removeRes.code !== 0) {
				throw new Error(removeRes.stderr || removeRes.stdout || "git worktree remove failed");
			}
			const pruneRes = await execChecked(pi, "git", ["worktree", "prune"], { cwd, timeout: 15000 });
			if (pruneRes.code !== 0) {
				throw new Error(pruneRes.stderr || pruneRes.stdout || "git worktree prune failed");
			}
			log.info("worktree", "Worktree removed");
			if (!skipBranch) {
				const branchRes = await execChecked(pi, "git", ["branch", "-D", worktreeBranch], {
					cwd,
					timeout: 10000,
				});
				if (branchRes.code !== 0) {
					throw new Error(
						branchRes.stderr || branchRes.stdout || `git branch -D ${worktreeBranch} failed`,
					);
				}
				log.info("worktree", `Branch ${worktreeBranch} deleted`);
			}
		},
		notify,
		"worktree",
	);
}
