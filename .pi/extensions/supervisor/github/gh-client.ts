// ─── gh CLI wrappers — typed versions ─────────────────────────────
// Low-level gh/ghJson/ghGraphQL with typed generic returns.
// Replaces raw `Promise<any>` returns from the old github.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDebugLogger } from "../lib/debug.ts";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── gh() — raw CLI wrapper ───────────────────────────────────────

// Cache GH_TOKEN from env or ~/.config/gh/hosts.yml to work around
// WSL auth context mismatch where pi.exec("gh", ...) can return 401
// even though the gh binary itself is properly authenticated.
// On WSL, pi.exec passes environment correctly but gh sometimes
// fails to find its credentials. Injecting GH_TOKEN explicitly
// ensures consistent auth across shell and pi.exec contexts.
const getGhToken = (() => {
	let token: string | null = null;
	return (): string | null => {
		if (token !== null) return token;
		if (process.env.GH_TOKEN && process.env.GH_TOKEN.length > 0) {
			token = process.env.GH_TOKEN;
			return token;
		}
		try {
			const configPath = join(homedir(), ".config", "gh", "hosts.yml");
			const yml = readFileSync(configPath, "utf8");
			const match = yml.match(/oauth_token:\s+(\S+)/);
			token = match ? match[1] : null;
		} catch {
			token = null;
		}
		return token;
	};
})();

export async function gh(
	pi: ExtensionAPI,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<string> {
	const log = getDebugLogger();
	const cmdLabel = args.slice(0, 2).join(" ");
	log.debug("gh-client", `gh ${cmdLabel}`, {
		args: args.slice(0, 8),
		timeout: opts?.timeout,
	});

	// Call gh via bash to inject GH_TOKEN, working around pi.exec auth
	// context issues on WSL.  Uses "$@" passthrough to avoid shell escaping.
	const ghToken = getGhToken();
	const shellArgs = ghToken
		? ["-c", `GH_TOKEN='${ghToken.replace(/'/g, "'\\''")}' gh "$@"`, "_", ...args]
		: args;

	const result = await pi.exec(ghToken ? "bash" : "gh", shellArgs, {
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

// ─── ghJson<T>() — typed JSON output ──────────────────────────────

export async function ghJson<T = unknown>(
	pi: ExtensionAPI,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<T | null> {
	const output = await gh(pi, args, opts);
	if (!output) return null;
	return JSON.parse(output) as T;
}

// ─── ghGraphQL<T>() — typed GraphQL wrapper ───────────────────────

export async function ghGraphQL<T = unknown>(
	pi: ExtensionAPI,
	query: string,
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<T | null> {
	const log = getDebugLogger();
	const queryPreview = query.replace(/\s+/g, " ").slice(0, 120);
	log.debug("gh-client", `ghGraphQL: ${queryPreview}...`);
	const result = await gh(
		pi,
		["api", "graphql", "--header", "Accept: application/vnd.github+json", "-f", `query=${query}`],
		opts,
	);
	if (!result) {
		log.warn("gh-client", "ghGraphQL returned empty result");
		return null;
	}
	const parsed = JSON.parse(result) as T;
	log.debug("gh-client", `ghGraphQL OK — response len: ${result.length}`);
	return parsed;
}
