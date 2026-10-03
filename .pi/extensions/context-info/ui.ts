/**
 * UI URL resolver — derive-only parity copy of the CLI's
 * uiHostPort (cmd/cheasee-pi/identity.go).
 *
 * The CLI (Go, host process) owns the port-resolution policy:
 * cheasee-settings.json docker.uiPort > env PI_UI_PORT > derived
 * base+fnv32(slug)%range, probed next-free on the HOST loopback. This module
 * re-derives the same value inside the container WITHOUT probing — the
 * container's loopback is a different namespace than the host's, so a probe
 * there would yield garbage. `cheasee-pi start` forwards the bound-first
 * resolved host port via the PI_UI_PORT exec env, so the in-session footer
 * link matches the printed `ℹ UI:` hint; this resolver is the fallback when
 * that env is absent (e.g. a session started outside the CLI, or resolution
 * failure on the CLI side).
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
import { fnv32, repoSlug, resolveWorkspaceRoot } from "./codeflow.ts";

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
 *  malformed (fall through to env/derived, mirroring the CLI's
 *  error-ignored settings read). */
function readSettingsUIPort(root: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(join(root, SETTINGS_FILE), "utf-8")) as {
			docker?: { uiPort?: unknown };
		};
		const port = parsed?.docker?.uiPort;
		return typeof port === "string" && port !== "" ? port : null;
	} catch {
		return null;
	}
}

/**
 * Resolves the UI host port for the session: settings docker.uiPort > env
 * PI_UI_PORT (the value the CLI forwards) > derived
 * base+fnv32(slug)%range. Null when no workspace marker is reachable from cwd
 * (nothing to anchor on — CLI sessions are always marker-gated, so this only
 * fires for sessions started outside any workspace).
 */
export async function uiHostPort(cwd: string): Promise<string | null> {
	const root = resolveWorkspaceRoot(cwd);
	if (root === null) return null;
	const settings = readSettingsUIPort(root);
	if (settings !== null) return settings;
	if (process.env.PI_UI_PORT) return process.env.PI_UI_PORT;
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
