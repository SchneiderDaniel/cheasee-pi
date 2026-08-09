/**
 * load-config.ts — Project-local harness config loader with trust gate.
 *
 * Loads `.pi/harness-config.json` when present and the project is trusted.
 * Falls back to default rules when the file is missing or the project is not trusted.
 *
 * Owns the I/O boundary (reads filesystem, calls isProjectTrusted()).
 * Returns merged ResolvedHarnessRules for use by AgentHarness.
 *
 * @packageDocumentation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadDefaultRules } from "./harness-rules.ts";
import type { ResolvedHarnessRules, ToolMeta } from "./harness-rules.ts";

// ── Types ──

/** Expected shape of `.pi/harness-config.json`. */
interface ProjectHarnessConfig {
	toolMeta?: Record<string, ToolMeta>;
	cascadeThreshold?: number;
}

/** Minimal context for config loading — a subset of ToolCallContext. */
export interface ConfigLoaderContext {
	isProjectTrusted?: () => boolean;
	ui?: {
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};
	sessionManager?: {
		getCwd?: () => string;
	};
}

// ── Constants ──

const CONFIG_RELATIVE_PATH = path.join(".pi", "harness-config.json");
const ALLOWED_KEYS = new Set(["toolMeta", "cascadeThreshold"]);

// ── Exports ──

export { loadDefaultRules } from "./harness-rules.ts";
export type { ResolvedHarnessRules, ToolMeta } from "./harness-rules.ts";

/**
 * Load project harness configuration, gated by trust.
 *
 * @param ctx - Context with isProjectTrusted() and ui.notify()
 * @param projectRootOverride - Optional override for project root (used in tests)
 * @returns Resolved harness rules (defaults or merged with project config)
 */
export function loadProjectConfig(
	ctx: ConfigLoaderContext,
	projectRootOverride?: string,
): ResolvedHarnessRules {
	const defaults = loadDefaultRules();

	// Determine config path
	const projectRoot = projectRootOverride ?? process.cwd();
	const configPath = path.join(projectRoot, CONFIG_RELATIVE_PATH);

	// File missing → use defaults
	if (!fs.existsSync(configPath)) {
		return defaults;
	}

	// Check project trust
	let isTrusted: boolean;
	try {
		isTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
	} catch (e) {
		// Fail-closed: rethrow the trust error
		throw e;
	}

	if (!isTrusted) {
		ctx.ui?.notify?.(
			"Project harness config found but project is not trusted — using default rules",
			"warning",
		);
		return defaults;
	}

	// Read and parse config file
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, "utf-8");
	} catch (e) {
		throw new Error(`Failed to read .pi/harness-config.json: ${(e as Error).message}`);
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(`Failed to parse .pi/harness-config.json: ${(e as Error).message}`);
	}

	// Validate keys — reject unknown keys
	for (const key of Object.keys(parsed)) {
		if (!ALLOWED_KEYS.has(key)) {
			throw new Error(
				`Unknown key in .pi/harness-config.json: "${key}". Allowed keys: toolMeta, cascadeThreshold`,
			);
		}
	}

	// Apply cascadeThreshold override (if present)
	if (typeof parsed.cascadeThreshold === "number") {
		if (parsed.cascadeThreshold < 1) {
			throw new Error("cascadeThreshold must be a positive number");
		}
		defaults.cascadeThreshold = parsed.cascadeThreshold;
	}

	// Apply toolMeta overrides (shallow merge per tool)
	if (parsed.toolMeta && typeof parsed.toolMeta === "object") {
		for (const [toolName, meta] of Object.entries(parsed.toolMeta as Record<string, unknown>)) {
			if (typeof meta !== "object" || meta === null) {
				throw new Error(`toolMeta.${toolName} must be an object`);
			}
			defaults.toolMeta[toolName] = {
				...defaults.toolMeta[toolName],
				...(meta as ToolMeta),
			};
		}
	}

	return defaults;
}
