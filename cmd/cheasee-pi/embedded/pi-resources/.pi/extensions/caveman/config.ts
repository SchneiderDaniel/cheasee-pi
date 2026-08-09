/**
 * Caveman config persistence + runtime state
 *
 * Uses closure-based state (not module-level mutable exports).
 * Accepts optional configPath for test isolation.
 * No TUI or pi API dependency — pure I/O.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { Level, CavemanConfig } from "./types.ts";
import { LEVELS, DEFAULT_CONFIG } from "./types.ts";

// ---------------------------------------------------------------------------
// Config store factory
// ---------------------------------------------------------------------------

export interface ConfigStore {
	ensureConfigLoaded(): Promise<void>;
	getConfig(): CavemanConfig;
	saveConfig(config: CavemanConfig): Promise<void>;
	getLevel(): Level;
	setLevel(level: Level): void;
}

/**
 * Create a config store with closure-encapsulated state.
 *
 * @param configPath — optional path to config file (defaults to ~/.pi/agent/caveman.json)
 */
export function createConfigStore(configPath?: string): ConfigStore {
	const resolvedPath = configPath ?? join(homedir(), ".pi", "agent", "caveman.json");

	let config: CavemanConfig = { ...DEFAULT_CONFIG };
	let currentLevel: Level = "off";
	let configLoadPromise: Promise<void> | null = null;
	let saveQueue: Promise<void> = Promise.resolve();

	const ensureConfigLoaded = async () => {
		if (!configLoadPromise) {
			configLoadPromise = (async () => {
				try {
					const raw = await readFile(resolvedPath, "utf8");
					const parsed = JSON.parse(raw);
					config = {
						defaultLevel: LEVELS.includes(parsed.defaultLevel)
							? parsed.defaultLevel
							: DEFAULT_CONFIG.defaultLevel,
						showStatus:
							typeof parsed.showStatus === "boolean"
								? parsed.showStatus
								: DEFAULT_CONFIG.showStatus,
					};
				} catch {
					config = { ...DEFAULT_CONFIG };
				}
			})();
		}
		await configLoadPromise;
	};

	const saveConfig = async (newConfig: CavemanConfig): Promise<void> => {
		config = newConfig; // Update in-memory immediately
		saveQueue = saveQueue.then(async () => {
			try {
				const snapshot = JSON.stringify(newConfig, null, 2) + "\n";
				await mkdir(dirname(resolvedPath), { recursive: true });
				await writeFile(resolvedPath, snapshot, "utf8");
			} catch (err) {
				console.error(`[caveman] Failed to save config to ${resolvedPath}:`, err);
			}
		});
		return saveQueue;
	};

	return {
		ensureConfigLoaded,
		getConfig: () => config,
		saveConfig,
		getLevel: () => currentLevel,
		setLevel: (level: Level) => {
			currentLevel = level;
		},
	};
}
