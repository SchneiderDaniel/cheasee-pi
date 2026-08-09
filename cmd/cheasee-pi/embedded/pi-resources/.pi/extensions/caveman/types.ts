/**
 * Types for caveman extension
 *
 * Pure type definitions, zero runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export const LEVELS = ["off", "lite", "full", "ultra"] as const;
export type Level = (typeof LEVELS)[number];

export const STOP_ALIASES = new Set(["off", "stop", "quit"]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CavemanConfig {
	/** Level to apply on new sessions. "off" means don't auto-enable. */
	defaultLevel: Level;
	/** Whether to show the animated footer status. */
	showStatus: boolean;
}

export const DEFAULT_CONFIG: CavemanConfig = {
	defaultLevel: "lite",
	showStatus: true,
};

// ---------------------------------------------------------------------------
// Command options
// ---------------------------------------------------------------------------

export const CAVEMAN_COMMAND_OPTIONS = [
	{ value: "lite", label: "lite", description: "Professional, no fluff" },
	{ value: "full", label: "full", description: "Classic caveman" },
	{ value: "ultra", label: "ultra", description: "Maximum compression" },
	{ value: "off", label: "off", description: "Disable caveman mode" },
	{ value: "stop", label: "stop", description: "Disable caveman mode" },
	{ value: "quit", label: "quit", description: "Disable caveman mode" },
	{ value: "status", label: "status", description: "Show caveman and prompt context info" },
	{ value: "config", label: "config", description: "Open settings dialog" },
] as const;
