/**
 * Configuration loading and backend resolution for ripgrep-search.
 *
 * Loads SearchConfig from .pi/settings.json, resolves the active backend
 * based on user preference and ripgrep availability.
 */

import type { SearchConfig } from "./types.ts";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const DEFAULT_CONFIG: SearchConfig = {
	searchBackend: "auto",
	maxLineLength: 200,
};

const MAX_LINE_LENGTH_MAX = 2000;
const MAX_LINE_LENGTH_DEFAULT = 200;

/**
 * Load search configuration from .pi/settings.json.
 * Falls back to defaults on missing file, parse errors, or missing keys.
 */
export function loadSearchConfig(cwd: string): SearchConfig {
	try {
		const settingsPath = join(cwd, ".pi", "settings.json");
		const raw = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw);
		const search = settings?.search;

		if (!search) return { ...DEFAULT_CONFIG };

		let searchBackend: SearchConfig["searchBackend"] = DEFAULT_CONFIG.searchBackend;
		if (
			search.searchBackend === "ripgrep" ||
			search.searchBackend === "grep" ||
			search.searchBackend === "auto"
		) {
			searchBackend = search.searchBackend;
		}

		let maxLineLength = MAX_LINE_LENGTH_DEFAULT;
		if (
			typeof search.maxLineLength === "number" &&
			Number.isInteger(search.maxLineLength) &&
			search.maxLineLength > 0
		) {
			maxLineLength = Math.min(search.maxLineLength, MAX_LINE_LENGTH_MAX);
		}

		return { searchBackend, maxLineLength };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Resolve the active search backend based on user config and rg availability.
 * - "ripgrep": forces ripgrep (returns error string if rg not available)
 * - "grep": forces grep (skips rg detection)
 * - "auto": uses ripgrep if available, grep otherwise
 */
export function resolveBackend(
	config: SearchConfig,
	rgAvailable: boolean,
): { backend: "ripgrep" | "grep"; error?: string } {
	if (config.searchBackend === "ripgrep") {
		if (!rgAvailable) {
			return {
				backend: "ripgrep",
				error:
					"ripgrep not found on PATH. Install rg or set searchBackend to 'auto' or 'grep' in .pi/settings.json.",
			};
		}
		return { backend: "ripgrep" };
	}
	if (config.searchBackend === "grep") {
		return { backend: "grep" };
	}
	// auto
	return { backend: rgAvailable ? "ripgrep" : "grep" };
}

/**
 * Detect if ripgrep is available via PATH check (primary) or spawn fallback.
 *
 * Primary: check process.env.PATH directly for rg executable.
 *   - Zero overhead, no subprocess spawn, no timeout risk
 *   - Uses same PATH as the Node.js process
 *
 * Fallback: spawn "rg --version" via exec (handles environments where
 *   subprocess PATH differs from process.env.PATH).
 */
export async function ripgrepAvailable(
	exec: (
		command: string,
		args: string[],
		options?: { timeout?: number },
	) => Promise<{
		code: number;
		stdout: string;
		stderr: string;
	}>,
): Promise<boolean> {
	// Primary: PATH directory check (no spawn, instant, reliable)
	const pathDirs = (process.env.PATH ?? "").split(delimiter);
	for (const dir of pathDirs) {
		if (!dir) continue;
		try {
			accessSync(join(dir, "rg"), constants.X_OK);
			return true;
		} catch {
			// Not in this directory, continue
		}
	}

	// Fallback 1: check pi's own binary directory (~/.pi/agent/bin)
	const homeDir = process.env.HOME || "";
	if (homeDir) {
		try {
			accessSync(join(homeDir, ".pi", "agent", "bin", "rg"), constants.X_OK);
			return true;
		} catch {}
	}

	// Fallback 2: spawn-based detection for exotic environments
	try {
		const result = await exec("rg", ["--version"], { timeout: 3_000 });
		if (result.code === 0) return true;
		console.warn(
			"[ripgrep-search] `rg --version` failed (exit=" +
				result.code +
				"), falling back to grep. Install/check rg on PATH for faster search.",
		);
		return false;
	} catch (err) {
		console.warn(
			"[ripgrep-search] ripgrep not found on PATH. Falling back to grep. " +
				"Install ripgrep (https://github.com/BurntSushi/ripgrep) for faster search.",
		);
		return false;
	}
}
