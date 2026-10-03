/**
 * UI URL resolver — derive-only parity copy of the CLI's
 * uiHostPort (cmd/cheasee-pi/identity.go).
 *
 * The CLI (Go, host process) owns the port-resolution policy for the compose
 * mapping: cheasee-settings.json docker.uiPort > env PI_UI_PORT > derived
 * base+fnv32(slug)%range, probed next-free on the HOST loopback. This module
 * re-derives the same value inside the container WITHOUT probing — the
 * container's loopback is a different namespace than the host's, so a probe
 * there would yield garbage.
 *
 * In-container precedence is env PI_UI_PORT FIRST, then settings, then
 * derived. `cheasee-pi start` forwards the bound-first resolved host port
 * (resolveUIHostPort — the port the running sidecar actually published, which
 * can differ from a stale docker.uiPort on a re-up), so the forwarded value
 * must win over the settings file, or the footer link would disagree with the
 * printed `ℹ UI:` hint in exactly that stale-sidecar case. Settings/derived
 * remain the fallback for sessions started outside the CLI.
 *
 * PI_UI_PORT defined-but-empty is the CLI's explicit "host-port resolution
 * failed" signal (range exhausted): the extension suppresses the UI link
 * rather than deriving a port that belongs to another workspace's sidecar. An
 * ABSENT PI_UI_PORT means no CLI ran (e.g. pi started directly), so deriving
 * is still correct there.
 *
 * PI_UI_PORT holds a HOST port here — the UI sidecar listens on container
 * port 3000, published to the host. Never treat this value as an in-container
 * port.
 *
 * Pure derivation + thin fs I/O — never emits ANSI; the OSC 8 hyperlink
 * wrapping is owned by the footer renderer.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fnv32, repoSlug, resolveWorkspaceRoot, validPort } from "./codeflow.ts";

/** Workspace marker — the "initialized" gate both CLI and extension share. */
const SETTINGS_FILE = "cheasee-settings.json";
/** Low end of the derived port range, must match uiPortBase (Go). */
const UI_PORT_BASE = 9500;
/** Span of the derived range, must match uiPortRange (Go). */
const UI_PORT_RANGE = 1024;

/** Derived UI host port for a slug: base + fnv32(slug) % range → always in
 *  [9500, 10523] inclusive. No probe — the CLI's next-free fallback cannot be
 *  replicated from inside the container (wrong loopback namespace). */
export function uiPortFromSlug(slug: string): number {
	return UI_PORT_BASE + (fnv32(slug) % UI_PORT_RANGE);
}

/** Reads docker.uiPort from the workspace settings; null when absent or
 *  malformed (fall through to derived, mirroring the CLI's error-ignored
 *  settings read). */
function readSettingsUIPort(root: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(join(root, SETTINGS_FILE), "utf-8")) as {
			docker?: { uiPort?: unknown };
		};
		const port = parsed?.docker?.uiPort;
		// Invalid settings fall through to env/derivation; validPort blocks
		// control-char payloads before they reach a URL/OSC 8 sequence.
		return validPort(typeof port === "string" ? port : null);
	} catch {
		return null;
	}
}

/**
 * Resolves the UI host port for the session: env PI_UI_PORT (the bound-first
 * value the CLI forwards — authoritative) > settings docker.uiPort > derived
 * base+fnv32(slug)%range. Null when no workspace marker is reachable from cwd
 * (nothing to anchor on — CLI sessions are always marker-gated, so this only
 * fires for sessions started outside any workspace).
 */
export async function uiHostPort(cwd: string): Promise<string | null> {
	const root = resolveWorkspaceRoot(cwd);
	if (root === null) return null;
	// Env first: `cheasee-pi start` forwards the bound-first resolved host port
	// (resolveUIHostPort), authoritative over docker.uiPort — on a re-up the
	// sidecar's live bind can differ from a stale settings value, and the
	// printed `ℹ UI:` hint uses the forwarded value. The CLI also forwards an
	// EMPTY PI_UI_PORT when its own resolution fails (host port range
	// exhausted): a defined-but-empty value means "resolved, but unavailable"
	// and suppresses the link — deriving then would name an occupied port that
	// is not this workspace's UI. An absent key means no CLI ran at all, so
	// deriving stays correct for direct pi sessions.
	if (process.env.PI_UI_PORT !== undefined) return validPort(process.env.PI_UI_PORT);
	const settings = readSettingsUIPort(root);
	if (settings !== null) return settings;
	return String(uiPortFromSlug(await repoSlug(root)));
}

/** The browser URL for the web control center at the resolved port. The host
 *  literal is 127.0.0.1, never `localhost`: the compose mapping binds the
 *  host side to IPv4 loopback only (see ui_hint.go). No trailing slash. */
export async function uiUrl(cwd: string): Promise<string | null> {
	const port = await uiHostPort(cwd);
	if (port === null) return null;
	return `http://127.0.0.1:${port}`;
}
