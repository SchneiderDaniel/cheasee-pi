/**
 * CodeFlow URL resolver — derive-only parity copy of the CLI's
 * codeflowHostPort (cmd/cheasee-pi/identity.go).
 *
 * The CLI (Go, host process) owns the port-resolution policy:
 * cheasee-settings.json docker.codeflowPort > env CODEFLOW_PORT > derived
 * base+fnv32(slug)%range, probed next-free on the HOST loopback. This module
 * re-derives the same value inside the container WITHOUT probing — the
 * container's loopback is a different namespace than the host's, so a probe
 * there would yield garbage. `cheasee-pi start` now forwards the CLI-resolved
 * port via the CODEFLOW_PORT exec env, so the in-session hint matches the
 * actually-bound port even in the rare probe-shift cases; this resolver is
 * the fallback when that env is absent (e.g. a session started outside the
 * CLI, or resolution failure on the CLI side).
 *
 * Pure derivation + thin fs/git I/O — never emits ANSI; OSC 8 hyperlink
 * wrapping is owned by the notify site in index.ts.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Workspace marker — the "initialized" gate both CLI and extension share. */
const SETTINGS_FILE = "cheasee-settings.json";
/** Sibling bare clone, mounted /workspaces/.bare (see compose file). */
const BARE_DIR = ".bare";
/** Low end of the derived port range, must match codeflowPortBase (Go). */
const CODEFLOW_PORT_BASE = 8470;
/** Span of the derived range, must match codeflowPortRange (Go). */
const CODEFLOW_PORT_RANGE = 1024;
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

// ── Pure derivation ─────────────────────────────

/**
 * FNV-1a 32-bit hash — byte-identical to Go `hash/fnv` New32a for the ASCII
 * slug charset (slugs are lowercase alphanumerics + '-' by construction, so
 * each charCodeAt is one byte).
 */
export function fnv32(s: string): number {
	let h = FNV_OFFSET_BASIS >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, FNV_PRIME) >>> 0;
	}
	return h >>> 0;
}

/** Parsed git remote identity — mirrors parseGitRemote's (owner, repo). */
export interface GitRemote {
	owner: string;
	repo: string;
}

/**
 * Parses a git remote URL into owner/repo, mirroring the CLI's
 * parseGitRemote: ".git" stripped; scheme://host/path and scp-like
 * git@host:owner/repo forms both supported. Owner-less or unparseable
 * input → null (the caller falls back to the basename slug).
 */
export function parseGitRemote(raw: string): GitRemote | null {
	let url = raw.trim();
	url = url.replace(/\.git$/, "");
	const schemeIdx = url.indexOf("://");
	if (schemeIdx >= 0) {
		// scheme://host/path — drop the scheme and the host
		url = url.slice(schemeIdx + 3);
		const j = url.indexOf("/");
		if (j < 0) return null;
		url = url.slice(j + 1);
	} else {
		// scp-like git@host:owner/repo — drop everything through the colon
		const i = url.lastIndexOf(":");
		if (i >= 0) url = url.slice(i + 1);
	}
	url = url.replace(/^\/+|\/+$/g, "");
	const parts = url.split("/");
	if (parts.length >= 2 && parts[parts.length - 1] !== "") {
		return { owner: parts.slice(0, -1).join("/"), repo: parts[parts.length - 1] };
	}
	if (parts.length === 1 && parts[0] !== "") {
		return { owner: "", repo: parts[0] };
	}
	return null;
}

/**
 * Lowercases and maps non-alphanumerics to '-' — parity with the CLI's
 * sanitizeSlug (valid docker/compose charset). Consecutive separators are not
 * collapsed; leading/trailing '-' are trimmed.
 */
export function sanitizeSlug(s: string): string {
	let out = "";
	for (const ch of s.toLowerCase()) {
		if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
			out += ch;
		} else {
			out += "-";
		}
	}
	return out.replace(/^-+|-+$/g, "");
}

/**
 * Derived CodeFlow host port for a slug: base + fnv32(slug) % range → always
 * in [8470, 9493] inclusive. No probe — the CLI's next-free fallback cannot
 * be replicated from inside the container (wrong loopback namespace).
 */
export function codeflowPortFromSlug(slug: string): number {
	return CODEFLOW_PORT_BASE + (fnv32(slug) % CODEFLOW_PORT_RANGE);
}

// ── Workspace identity I/O ──────────────────────

/**
 * Anchors on the workspace root: walks up from cwd to the
 * cheasee-settings.json marker (the same anchor the CLI's resolveStartWorkspace
 * uses — NOT dirname(cwd), which breaks when pi starts in a subfolder).
 */
export function resolveWorkspaceRoot(cwd: string): string | null {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, SETTINGS_FILE))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Docker-safe repo identity for a workspace: owner/repo from the sibling
 * bare repo's remote URL when resolvable, else the repo name, else the
 * workspace folder basename — mirroring the CLI's repoSlug fallback chain.
 */
export async function repoSlug(root: string): Promise<string> {
	const url = await bareRepoURL(root);
	if (url) {
		const remote = parseGitRemote(url);
		if (remote) {
			if (remote.owner && remote.repo) return sanitizeSlug(remote.owner + "-" + remote.repo);
			if (remote.repo) return sanitizeSlug(remote.repo);
		}
	}
	return sanitizeSlug(basename(root));
}

/** Reads remote.origin.url from the sibling bare clone — "" on any error. */
async function bareRepoURL(root: string): Promise<string> {
	const bare = join(dirname(root), BARE_DIR);
	try {
		const { stdout } = await execFileAsync(
			"git",
			["--git-dir", bare, "config", "--get", "remote.origin.url"],
			{ timeout: 5000 },
		);
		return stdout.trim();
	} catch {
		return "";
	}
}

// ── Resolution precedence ───────────────────────

/**
 * Resolves the CodeFlow host port for the session: settings
 * docker.codeflowPort > env CODEFLOW_PORT (the value the CLI forwards) >
 * derived base+fnv32(slug)%range. Null when no workspace marker is reachable
 * from cwd (nothing to anchor on — CLI sessions are always marker-gated, so
 * this only fires for sessions started outside any workspace).
 */
export async function codeflowHostPort(cwd: string): Promise<string | null> {
	const root = resolveWorkspaceRoot(cwd);
	if (root === null) return null;
	const settings = readSettingsCodeflowPort(root);
	if (settings !== null) return settings;
	if (process.env.CODEFLOW_PORT) return process.env.CODEFLOW_PORT;
	return String(codeflowPortFromSlug(await repoSlug(root)));
}

/** Reads docker.codeflowPort from the workspace settings; null when absent
 * or malformed (fall through to env/derived, mirroring the CLI's
 * error-ignored settings read). */
function readSettingsCodeflowPort(root: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(join(root, SETTINGS_FILE), "utf-8")) as {
			docker?: { codeflowPort?: unknown };
		};
		const port = parsed?.docker?.codeflowPort;
		return typeof port === "string" && port !== "" ? port : null;
	} catch {
		return null;
	}
}

/** The browser URL for the mounted workspace at the resolved port. */
export async function codeflowUrl(cwd: string): Promise<string | null> {
	const port = await codeflowHostPort(cwd);
	if (port === null) return null;
	return `http://localhost:${port}/?repo=local/workspace&run=1`;
}