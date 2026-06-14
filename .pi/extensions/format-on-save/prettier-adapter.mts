/**
 * prettier-adapter.mts — PrettierFormatter adapter.
 *
 * Wraps the Prettier programmatic API behind the Formatter port.
 * Uses `prettier.format()`, `prettier.resolveConfig()` in-process instead
 * of subprocess CLI, eliminating ~200–500ms of Node.js boot per call.
 *
 * Config resolution matches the legacy root-only behavior (uses .prettierrc
 * from the project root, NOT nearest-file search). This is a documented
 * divergence from prettier's default `resolveConfig` behavior.
 *
 * Dependencies (prettier module + fs module) are injectable for testability.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Formatter, FormatResult } from "./ports.mts";

// ─── Supported File Extensions ────────────────────────────────────────

const SUPPORTED_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".json",
	".jsonc",
	".json5",
] as const;

// ─── Default Prettier Plugins ─────────────────────────────────────────

/**
 * Default prettier plugins loaded eagerly at construction time.
 * Covers all supported extensions:
 *   - TypeScript: .ts, .tsx, .mts, .cts
 *   - Babel/JS:   .js, .jsx, .mjs, .cjs (also provides JSON parsers)
 *   - Estree:     required by babel plugin
 */
const DEFAULT_PLUGINS: unknown[] = [
	// Dynamic imports to avoid top-level load failures
];

async function loadDefaultPlugins(): Promise<unknown[]> {
	const [tsPlugin, babelPlugin, estreePlugin] = await Promise.all([
		import("prettier/plugins/typescript"),
		import("prettier/plugins/babel"),
		import("prettier/plugins/estree"),
	]);
	return [tsPlugin, babelPlugin, estreePlugin];
}

// ─── Injection Types ──────────────────────────────────────────────────

/** Prettier module subset used by the adapter. */
export interface PrettierModule {
	format(source: string, options: Record<string, unknown>): Promise<string>;
	resolveConfig(
		filePath: string,
		options?: Record<string, unknown>,
	): Promise<Record<string, unknown> | null>;
}

/** File system operations used by the adapter. */
export interface FileSystem {
	readFile(path: string, encoding: "utf-8"): Promise<string>;
	writeFile(path: string, content: string, encoding: "utf-8"): Promise<void>;
}

const defaultFs: FileSystem = { readFile, writeFile };

// ─── PrettierFormatter ────────────────────────────────────────────────

/**
 * PrettierFormatter — adapts Prettier's programmatic API to the Formatter port.
 *
 * Loads plugins eagerly for all supported extensions at construction time.
 * Resolves .prettierrc from the project root (matching legacy root-only behavior).
 *
 * @example
 * ```ts
 * const formatter = new PrettierFormatter(ctx.cwd);
 * const result = await formatter.format("/repo/src/app.ts");
 * ```
 */
export class PrettierFormatter implements Formatter {
	private readonly rootConfigPath: string;
	private readonly projectRoot: string;
	private readonly prettierModule: PrettierModule | undefined;
	private readonly fsModule: FileSystem | undefined;
	private plugins: unknown[] | null = null;
	private pluginLoadError: string | null = null;

	/**
	 * @param projectRoot    Project root directory containing .prettierrc.
	 * @param prettierModule Optional injected prettier module (for testing).
	 * @param fsModule       Optional injected fs module (for testing).
	 */
	constructor(projectRoot: string, prettierModule?: PrettierModule, fsModule?: FileSystem) {
		this.projectRoot = projectRoot;
		this.prettierModule = prettierModule;
		this.fsModule = fsModule;
		this.rootConfigPath = resolve(projectRoot, ".prettierrc");
	}

	/** @inheritdoc */
	canHandle(path: string): boolean {
		const lower = path.toLowerCase();
		return (SUPPORTED_EXTENSIONS as readonly string[]).some((ext) => lower.endsWith(ext));
	}

	/** @inheritdoc */
	async format(path: string): Promise<FormatResult> {
		try {
			const fs = this.fsModule ?? defaultFs;
			const prettier = await this.getPrettier();

			// Read the file
			const source = await fs.readFile(path, "utf-8");

			// Resolve config from project root (root-only, matching current behavior)
			const config =
				(await prettier.resolveConfig(path, {
					config: this.rootConfigPath,
				})) ?? {};

			// Format with prettier
			const plugins = this.plugins ?? (await this.ensurePlugins());
			const formatted = await prettier.format(source, {
				...config,
				filepath: path,
				plugins,
			});

			// If unchanged, skip write
			if (formatted === source) {
				return { formatted: false };
			}

			// Write back
			await fs.writeFile(path, formatted, "utf-8");
			return { formatted: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { formatted: false, error: message };
		}
	}

	/**
	 * Get the prettier module (injected or default).
	 * If no module was injected, dynamically import it.
	 */
	private async getPrettier(): Promise<PrettierModule> {
		if (this.prettierModule) return this.prettierModule;
		// Dynamic import of prettier
		const mod = await import("prettier");
		return mod as unknown as PrettierModule;
	}

	/**
	 * Ensure plugins are loaded. Uses injected plugins first,
	 * otherwise loads default plugins dynamically.
	 */
	private async ensurePlugins(): Promise<unknown[]> {
		if (this.plugins) return this.plugins;
		if (this.pluginLoadError) {
			throw new Error(`PrettierFormatter: plugins failed to load: ${this.pluginLoadError}`);
		}
		try {
			this.plugins = await loadDefaultPlugins();
			return this.plugins;
		} catch (err) {
			this.pluginLoadError = err instanceof Error ? err.message : String(err);
			throw new Error(`PrettierFormatter: plugin load failed: ${this.pluginLoadError}`);
		}
	}
}
