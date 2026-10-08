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

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { matchesAnyExtension } from "./file-match.mts";

import type { FileMutationQueue, Formatter, FormatResult } from "./ports.mts";

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

/**
 * Default mutation queue: pi's real process-wide file-mutation queue.
 * Defaulting to the real queue (not a passthrough) keeps the fix fail-closed
 * — a missing injection cannot silently reintroduce the lost update.
 */
const defaultQueue: FileMutationQueue = {
	withLock: (path, fn) => withFileMutationQueue(path, fn),
};

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
	private readonly queue: FileMutationQueue;
	private plugins: unknown[] | null = null;
	private pluginLoadError: string | null = null;

	/**
	 * @param projectRoot      Project root directory containing .prettierrc.
	 * @param prettierModule   Optional injected prettier module (for testing).
	 * @param fsModule         Optional injected fs module (for testing).
	 * @param fileMutationQueue Optional injected mutation queue; defaults to pi's.
	 */
	constructor(
		projectRoot: string,
		prettierModule?: PrettierModule,
		fsModule?: FileSystem,
		fileMutationQueue?: FileMutationQueue,
	) {
		this.projectRoot = projectRoot;
		this.prettierModule = prettierModule;
		this.fsModule = fsModule;
		this.queue = fileMutationQueue ?? defaultQueue;
		this.rootConfigPath = resolve(projectRoot, ".prettierrc");
	}

	/** @inheritdoc */
	canHandle(path: string): boolean {
		return matchesAnyExtension(path, SUPPORTED_EXTENSIONS);
	}

	/** @inheritdoc */
	async format(path: string): Promise<FormatResult> {
		try {
			const fs = this.fsModule ?? defaultFs;
			const prettier = await this.getPrettier();

			// Config + plugin loading is pure I/O on the prettier side: do it
			// OUTSIDE the lock so the critical section holds only read→format→write.
			const config =
				(await prettier.resolveConfig(path, {
					config: this.rootConfigPath,
				})) ?? {};
			const plugins = this.plugins ?? (await this.ensurePlugins());

			// Read INSIDE the lock: the snapshot must be taken under the same
			// mutex the agent's write/edit tools use, or a stale snapshot wins.
			return await this.queue.withLock(path, async () => {
				const source = await fs.readFile(path, "utf-8");

				const formatted = await prettier.format(source, {
					...config,
					filepath: path,
					plugins,
				});

				// If unchanged, skip write
				if (formatted === source) {
					return { formatted: false };
				}

				// Write INSIDE the lock
				await fs.writeFile(path, formatted, "utf-8");
				return { formatted: true };
			});
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
