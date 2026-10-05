// RTK Pi extension — rewrites bash commands to use rtk for token savings.
// Requires: rtk >= 0.23.0 in PATH.
//
// This is a thin delegating extension: all rewrite logic lives in `rtk rewrite`,
// which is the single source of truth (src/discover/registry.rs).
// To add or change rewrite rules, edit the Rust registry — not this file.
//
// Exit code contract for `rtk rewrite`:
//   0 + stdout  Rewrite found → mutate command
//   1           No RTK equivalent → pass through unchanged
//   3 + stdout  Rewrite (advisory) → mutate command

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const REWRITE_TIMEOUT_MS = 2_000;
const VERSION_PROBE_TIMEOUT_MS = 500;
const MIN_SUPPORTED_RTK_MINOR = 23;

type GateStatus = { disabled: boolean; reason?: string };
type GateEntry = { promise: Promise<GateStatus>; warned: boolean };

// One memoized probe per runtime (WeakMap → discarded on extension reload).
const versionGates = new WeakMap<ExtensionAPI, GateEntry>();

// Parse "X.Y.Z" semver, return [major, minor, patch] or null.
function parseSemver(raw: string): [number, number, number] | null {
	const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
	if (!m) return null;
	return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

// Probe rtk version; never throws. Missing/old/hung binary → disabled.
function probeVersion(pi: ExtensionAPI): Promise<GateStatus> {
	return pi
		.exec("rtk", ["--version"], { timeout: VERSION_PROBE_TIMEOUT_MS })
		.then((ver): GateStatus => {
			if (ver.killed || ver.code !== 0) {
				return { disabled: true, reason: "rtk binary not found in PATH" };
			}
			const parsed = parseSemver(ver.stdout.replace(/^rtk\s+/, ""));
			if (parsed) {
				const [major, minor] = parsed;
				if (major === 0 && minor < MIN_SUPPORTED_RTK_MINOR) {
					return { disabled: true, reason: `rtk ${ver.stdout.trim()} is too old (need >= 0.23.0)` };
				}
			}
			return { disabled: false };
		})
		.catch((err): GateStatus => ({
			disabled: true,
			reason: `rtk version probe failed: ${err}`,
		}));
}

// Memoized gate: coalesces concurrent callers and warns at most once per runtime.
async function checkVersion(pi: ExtensionAPI): Promise<GateStatus> {
	let entry = versionGates.get(pi);
	if (!entry) {
		entry = { promise: probeVersion(pi), warned: false };
		versionGates.set(pi, entry);
	}
	const status = await entry.promise;
	if (status.disabled && !entry.warned) {
		entry.warned = true;
		console.warn(`[rtk] ${status.reason} — extension disabled`);
	}
	return status;
}

// Calls `rtk rewrite`; returns the rewritten command or null (pass through).
async function rewriteCommand(
	pi: ExtensionAPI,
	cmd: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const result = await pi.exec("rtk", ["rewrite", cmd], {
		timeout: REWRITE_TIMEOUT_MS,
		signal,
	});
	if (result.killed) return null;
	if (result.code !== 0 && result.code !== 3) return null;
	return result.stdout.trim() || null;
}

export default async function (pi: ExtensionAPI) {
	// Registration only — no processes/sockets/timers in the factory (Pi lifecycle rule).
	// The probe runs here, before the first prompt, for a clean startup log.
	pi.on("session_start", async () => {
		if (process.env.RTK_DISABLED === "1") return;
		await checkVersion(pi);
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (!isToolCallEventType("bash", event)) return;

			const cmd = event.input.command;
			if (typeof cmd !== "string" || cmd.trim() === "") return;

			if (cmd.startsWith("rtk ")) return;
			if (process.env.RTK_DISABLED === "1") return;

			// Lazy backstop: headless modes never fire session_start, so await the gate here.
			const gate = await checkVersion(pi);
			if (gate.disabled) return;

			// Delegate to RTK.
			let rewritten = await rewriteCommand(pi, cmd, ctx.signal);
			if (rewritten && rewritten !== cmd) {
				// Default rtk read to aggressive filtering (no rtk config/env knob exists).
				// ponytail: inject --level aggressive only on `rtk read` rewrites; other subcommands already self-compact.
				if (rewritten.startsWith("rtk read ")) {
					rewritten = `rtk read --level aggressive ${rewritten.slice("rtk read ".length)}`;
				}
				event.input.command = rewritten;
			}
		} catch (err) {
			// Fail open: never block execution on an unexpected error.
			console.warn("[rtk] unexpected error in tool_call handler; passing through command", err);
			return;
		}
	});
}
