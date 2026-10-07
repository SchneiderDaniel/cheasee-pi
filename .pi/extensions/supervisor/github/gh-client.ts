// ─── gh CLI wrappers — typed versions ─────────────────────────────
// Low-level gh/ghJson with typed generic returns.
// Replaces raw `Promise<any>` returns from the old github.ts.

import type { ExecFn } from "../pipeline/helpers.ts";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
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
 * Resolve the GitHub token from GH_TOKEN or ~/.config/gh/hosts.yml.
 *
 * Env wins (trimmed, whitespace-only treated as unset), else the
 * `oauth_token:` line in the gh credential store, else null. Intentionally
 * uncached: a memoised null would poison later calls once `gh auth login`
 * or an exported GH_TOKEN lands mid-session. GH_TOKEN is injected into
 * `gh`/`ghRaw` to work around WSL auth context mismatch where pi.exec
 * can return 401 even though the gh binary itself is authenticated.
 */
export function resolveGitHubToken(opts?: TokenResolutionOptions): string | null {
	const env = opts?.env ?? process.env;
	const envToken = env.GH_TOKEN?.trim();
	if (envToken) return envToken;
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
 * Which OAuth flow minted the active credential — key for the workflow-scope
 * remediation hint. cheasee-pi tokens live in auth.json and can only gain the
 * scope by re-running the device flow (`cheasee-pi init --reauth`); gh-minted
 * tokens are upgradable via `gh auth refresh -h github.com -s workflow`.
 * Heuristic is a cheap fs check; unknown prints both hints.
 */
export type TokenClass = "cheasee-pi" | "gh" | "unknown";

export function detectTokenClass(home: string = homedir()): TokenClass {
	// auth.json is the cheasee-pi init/--reauth source of truth. entrypoint.sh
	// re-imports it into gh, so a gh-hosted token may still be init-minted —
	// auth.json must win over hosts.yml.
	try {
		const authPath = join(home, ".config", "cheasee-pi", "auth.json");
		const auth = JSON.parse(readFileSync(authPath, "utf8")) as { github_token?: unknown };
		if (typeof auth.github_token === "string" && auth.github_token.length > 0) {
			return "cheasee-pi";
		}
	} catch {
		// not a cheasee-pi install — fall through
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

	// Call gh via bash to inject GH_TOKEN, working around exec auth
	// context issues on WSL.  Uses "$@" passthrough to avoid shell escaping.
	const ghToken = resolveGitHubToken();
	const shellArgs = ghToken
		? ["-c", `GH_TOKEN='${ghToken.replace(/'/g, "'\\''")}' gh "$@"`, "_", ...args]
		: args;

	const result = await exec(ghToken ? "bash" : "gh", shellArgs, {
		signal: opts?.signal,
		timeout: opts?.timeout ?? 30_000,
	});
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
	const ghToken = resolveGitHubToken();
	const shellArgs = ghToken
		? ["-c", `GH_TOKEN='${ghToken.replace(/'/g, "'\\''")}' gh "$@"`, "_", ...args]
		: args;

	return exec(ghToken ? "bash" : "gh", shellArgs, {
		signal: opts?.signal,
		timeout: opts?.timeout ?? 30_000,
	});
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

