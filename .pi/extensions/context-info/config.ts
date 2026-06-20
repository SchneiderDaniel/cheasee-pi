/**
 * Config loading for context-info extension
 *
 * Sync I/O (readFileSync, existsSync) deferred to loadConfig() call,
 * not executed at module load time.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import type { ContextStatusBarConfig, ThresholdEntry } from "./types.js";

// ─── Default thresholds ───────────────────────────────────────────

/** Default welcome timeout: 0 = no auto-dismiss */
const DEFAULT_WELCOME_TIMEOUT_MS = 0;

const DEFAULT_THRESHOLDS: ThresholdEntry[] = [
	{ maxTokens: 100_000 },
	{ maxTokens: 150_000 },
	{ maxTokens: null },
];

/** Read a single value from pi's global settings.json */
export function readPiSetting(key: string): string | undefined {
	try {
		const settingsPath = joinPath(homedir(), ".pi/agent/settings.json");
		if (!existsSync(settingsPath)) return undefined;
		const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
		if (typeof raw === "object" && raw !== null && key in raw) {
			const val = (raw as Record<string, unknown>)[key];
			return typeof val === "string" ? val : undefined;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Load config from .pi/settings.json
 * All sync I/O happens here, not at module scope.
 */
export function loadConfig(): ContextStatusBarConfig | null {
	const defaults: ContextStatusBarConfig = {
		enabled: true,
		thresholds: DEFAULT_THRESHOLDS,
		showTimer: true,
		showTps: true,
		showCache: true,
		welcomeTimeoutMs: DEFAULT_WELCOME_TIMEOUT_MS,
	};
	const settingsPath = ".pi/settings.json";
	if (!existsSync(settingsPath)) return defaults;

	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return defaults;
	}

	const raw = settings["contextStatusBar"];
	if (raw === undefined) return defaults;
	if (typeof raw !== "object" || raw === null) return defaults;

	const cfg = raw as Record<string, unknown>;

	let enabled = true;
	if ("enabled" in cfg && typeof cfg.enabled === "boolean") {
		enabled = cfg.enabled;
	}
	if (!enabled) return null;

	let thresholds: ThresholdEntry[];
	if (!Array.isArray(cfg.thresholds) || cfg.thresholds.length === 0) {
		thresholds = DEFAULT_THRESHOLDS;
	} else {
		const parsed: ThresholdEntry[] = [];
		for (const entry of cfg.thresholds) {
			if (typeof entry !== "object" || entry === null) continue;
			const e = entry as Record<string, unknown>;
			const maxTokens =
				e.maxTokens === null || e.maxTokens === undefined ? null : Number(e.maxTokens);
			if (maxTokens !== null && !Number.isFinite(maxTokens)) continue;
			parsed.push({ maxTokens: maxTokens as number | null });
		}
		thresholds = parsed.length > 0 ? parsed : DEFAULT_THRESHOLDS;
	}

	// Parse showTimer
	let showTimer = true;
	if ("showTimer" in cfg && typeof cfg.showTimer === "boolean") {
		showTimer = cfg.showTimer;
	}

	// Parse showTps
	let showTps = true;
	if ("showTps" in cfg && typeof cfg.showTps === "boolean") {
		showTps = cfg.showTps;
	}

	// Parse showCache
	let showCache = true;
	if ("showCache" in cfg && typeof cfg.showCache === "boolean") {
		showCache = cfg.showCache;
	}

	// Parse welcomeTimeoutMs
	let welcomeTimeoutMs = DEFAULT_WELCOME_TIMEOUT_MS;
	if (
		"welcomeTimeoutMs" in cfg &&
		typeof cfg.welcomeTimeoutMs === "number" &&
		Number.isFinite(cfg.welcomeTimeoutMs)
	) {
		welcomeTimeoutMs = cfg.welcomeTimeoutMs;
	}

	return { enabled, thresholds, showTimer, showTps, showCache, welcomeTimeoutMs };
}
