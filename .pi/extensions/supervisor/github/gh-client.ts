// ─── gh CLI wrappers — typed versions ─────────────────────────────
// Low-level gh/ghJson with typed generic returns.
// Replaces raw `Promise<any>` returns from the old github.ts.

import type { ExecFn, ExecResult } from "../../lib/port-types.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── gh() — raw CLI wrapper ───────────────────────────────────────

// ─── Token Resolution ────────────────────────────────────────────

/** Injection seam for {@link resolveGitHubToken}: override the home directory
 * and environment so the lookup is pure and testable. */
export interface TokenResolutionOptions {
	home?: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the GitHub token: `GH_TOKEN` → the `CHEASEE_AUTH_PATH` file →
 * `~/.config/gh/hosts.yml`.
 *
 * Env wins (trimmed; whitespace-only counts as unset). Second is the
 * `github_token` in the file `CHEASEE_AUTH_PATH` names — the container mounts
 * `auth.json` read-only there, mounts no host gh config dir, so that file beats
 * the `hosts.yml` the entrypoint seeds into the container-local tmpfs. Last is
 * the gh credential store's `oauth_token:` line, then null. Intentionally
 * uncached: a memoised null would poison later calls once `gh auth login`
 * lands mid-session. GH_TOKEN is passed to `gh`/`ghRaw` as a per-child env
 * option, working around a WSL auth-context mismatch where pi.exec can return
 * 401 even though the gh binary itself is authenticated.
 */
export function resolveGitHubToken(opts?: TokenResolutionOptions): string | null {
	const env = opts?.env ?? process.env;
	const envToken = env.GH_TOKEN?.trim();
	if (envToken) return envToken;
	const secretToken = tokenFromAuthFile(env.CHEASEE_AUTH_PATH?.trim());
	if (secretToken) return secretToken;
	try {
		const configPath = join(opts?.home ?? homedir(), ".config", "gh", "hosts.yml");
		const yml = readFileSync(configPath, "utf8");
		const match = yml.match(/oauth_token:\s+(\S+)/);
		return match ? match[1]!.trim() : null;
	} catch {
		return null;
	}
}

/**
 * Read `github_token` from a cheasee-pi auth file: the read-only secret the
 * container mounts (`CHEASEE_AUTH_PATH`) or, host-side, the legacy
 * `~/.config/cheasee-pi/auth.json`.
 *
 * An unset path, unreadable file, malformed JSON, non-string token, empty
 * token: all mean "no token here". The caller falls through to `hosts.yml` — a
 * credential file this code does not own is never a throw.
 */
function tokenFromAuthFile(path: string | undefined): string | null {
	if (!path) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { github_token?: unknown };
		const token = parsed.github_token;
		if (typeof token !== "string") return null;
		const trimmed = token.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

/**
 * Which OAuth flow minted the active credential — key for the workflow-scope
 * remediation hint. cheasee-pi tokens live in auth.json: only the device flow
 * (`cheasee-pi init --reauth`) grants the missing scope. gh-minted tokens
 * upgrade via `gh auth refresh -h github.com -s workflow`. Cheap fs probe;
 * unknown prints both hints.
 *
 * Probe order mirrors {@link resolveGitHubToken}, because the hint must name
 * the store the failed push used: `CHEASEE_AUTH_PATH` (the container's
 * read-only secret), then `~/.config/cheasee-pi/auth.json`, then
 * `~/.config/gh/hosts.yml`. The agent container mounts no host config
 * directory (issue #2076), so the legacy path never resolves there — probing
 * it alone reported `gh` for an init-minted token, sending the operator to a
 * refresh the next container recreate reverts.
 */
export type TokenClass = "cheasee-pi" | "gh" | "unknown";

/**
 * @param home Home directory the legacy `~/.config` stores hang off.
 * @param env Environment carrying `CHEASEE_AUTH_PATH` (defaults to the process
 *   env, which is what the container sets).
 */
export function detectTokenClass(
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): TokenClass {
	if (tokenFromAuthFile(env.CHEASEE_AUTH_PATH?.trim()) !== null) return "cheasee-pi";
	if (tokenFromAuthFile(join(home, ".config", "cheasee-pi", "auth.json")) !== null) {
		return "cheasee-pi";
	}
	try {
		const configPath = join(home, ".config", "gh", "hosts.yml");
		if (/oauth_token:\s*\S+/.test(readFileSync(configPath, "utf8"))) {
			return "gh";
		}
	} catch {
		// no gh login — fall through
	}
	return "unknown";
}

/**
 * Run `gh` with the resolved token injected through the child's environment.
 *
 * The token goes in the per-call `env` option of {@link ExecFn}, so it reaches
 * only the `gh` child: `process.env` is never mutated and no concurrently
 * spawned process can inherit it. This keeps the secret out of the command
 * string, argv and shell entirely.
 */
async function runGhWithToken(
	exec: ExecFn,
	args: string[],
	opts: { signal?: AbortSignal; timeout?: number } | undefined,
	token: string | null,
): Promise<ExecResult> {
	const execOpts = { signal: opts?.signal, timeout: opts?.timeout ?? 30_000 };
	if (token === null) return exec("gh", args, execOpts);
	return exec("gh", args, { ...execOpts, env: { GH_TOKEN: token } });
}

export async function gh(
	exec: ExecFn,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<string> {
	const log = getDebugLogger();
	const cmdLabel = args.slice(0, 2).join(" ");
	log.debug("gh-client", `gh ${cmdLabel}`, {
		args: args.slice(0, 8),
		timeout: opts?.timeout,
	});

	// GH_TOKEN is injected as a per-child env var (see runGhWithToken) to work
	// around exec auth context issues on WSL.
	const result = await runGhWithToken(exec, args, opts, resolveGitHubToken());
	if (result.code !== 0) {
		log.warn("gh-client", `gh ${cmdLabel} failed (code ${result.code})`, {
			args: args.slice(0, 8),
			stderr: (result.stderr || "").slice(0, 500),
		});
		throw new Error(`gh ${args[0]} failed: ${result.stderr || result.stdout}`);
	}
	log.debug("gh-client", `gh ${cmdLabel} OK`, {
		stdoutLen: (result.stdout || "").length,
	});
	return (result.stdout || "").trim();
}

export async function ghRaw(
	exec: ExecFn,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<ExecResult> {
	const log = getDebugLogger();
	const cmdLabel = args.slice(0, 2).join(" ");
	log.debug("gh-client", `ghRaw ${cmdLabel}`, { args: args.slice(0, 8) });

	// Same GH_TOKEN injection as gh(), but returns the raw ExecResult — no
	// stdout trim, no throw on non-zero exit — so HTTP headers (`gh api -i`,
	// e.g. X-OAuth-Scopes) survive for caller-side parsing.
	return runGhWithToken(exec, args, opts, resolveGitHubToken());
}

// ─── ghJson<T>() — typed JSON output ──────────────────────────────

export async function ghJson<T = unknown>(
	exec: ExecFn,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<T | null> {
	const output = await gh(exec, args, opts);
	if (!output) return null;
	return JSON.parse(output) as T;
}
