/**
 * ExtensionState — Shared mutable state for extension toggles
 *
 * Provides typed get/set over TypeBox-validated JSON with atomic writes,
 * serialized write queue, and pluggable storage adapter (file/in-memory).
 *
 * ## Usage
 *
 * ```ts
 * import { ExtensionState, FileStore, SessionExtensionsSchema } from "./extensionState.ts";
 *
 * const state = new ExtensionState(
 *   new FileStore(),
 *   SessionExtensionsSchema,
 * );
 *
 * const enabled = await state.get("logger");
 * await state.set("logger", false);
 * ```
 *
 * ## Adapter pattern
 *
 * - `FileStore` — production adapter with atomic write (tmp → fsync → rename)
 * - `InMemoryStore` — test seam, no I/O
 *
 * ## Write queue
 *
 * All `set()` calls are serialized through a promise chain to prevent
 * interleaved read-modify-write cycles when multiple handlers toggle
 * simultaneously.
 *
 * ## Schema and migration
 *
 * `Type.Optional(Type.Boolean({ default: true }))` auto-populates missing
 * keys on read, providing implicit migration from old formats without
 * an explicit versioning step. Unknown keys in the file are preserved
 * through read-modify-write cycles.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type TObject, type TProperties, type Static } from "typebox";
import { Check, Default, Errors } from "typebox/value";

// ── Types ──

export interface ExtensionStateStore {
	/** Read raw JSON string from storage. Returns `null` if no data exists. */
	read(): Promise<string | null>;
	/** Write raw JSON string to storage. */
	write(data: string): Promise<void>;
}

export interface OnErrorDetail {
	key?: string;
	error: Error;
	rawData?: string;
}

export type OnErrorHandler = (detail: OnErrorDetail) => void;

// ── InMemoryStore (test seam) ──

/**
 * In-memory store for unit tests. No I/O, deterministic.
 *
 * ```ts
 * const store = new InMemoryStore();
 * await store.write('{"a":1}');
 * const data = await store.read(); // '{"a":1}'
 * ```
 */
export class InMemoryStore implements ExtensionStateStore {
	private data: string | null = null;

	async read(): Promise<string | null> {
		return this.data;
	}

	async write(data: string): Promise<void> {
		this.data = data;
	}
}

// ── FileStore (production adapter with atomic writes) ──

export interface FileStoreOptions {
	/** State directory (default: `.pi/state`) */
	dir?: string;
	/** State filename (default: `session-extensions.json`) */
	filename?: string;
}

/**
 * Production store adapter backed by a JSON file on disk.
 *
 * Uses atomic write pattern (write temp → fsync → rename) to prevent
 * zero-byte or corrupt files on crash. Creates parent directories on write.
 *
 * @example
 * ```ts
 * const store = new FileStore({ dir: ".pi/state", filename: "session-extensions.json" });
 * ```
 */
export class FileStore implements ExtensionStateStore {
	private readonly statePath: string;

	constructor(options?: FileStoreOptions) {
		const dir = options?.dir ?? ".pi/state";
		const filename = options?.filename ?? "session-extensions.json";
		this.statePath = path.resolve(dir, filename);
	}

	/** Returns the resolved path (useful for assertions in tests). */
	get path(): string {
		return this.statePath;
	}

	async read(): Promise<string | null> {
		try {
			return fs.readFileSync(this.statePath, "utf-8");
		} catch (err: unknown) {
			if (isNodeError(err) && err.code === "ENOENT") return null;
			throw err;
		}
	}

	async write(data: string): Promise<void> {
		const dir = path.dirname(this.statePath);
		fs.mkdirSync(dir, { recursive: true });

		// Atomic write: temp file in same directory → fsync → rename
		const tmpPath = this.statePath + ".tmp";
		const fd = fs.openSync(tmpPath, "w");
		try {
			fs.writeFileSync(fd, data, "utf-8");
			fs.fsyncSync(fd);
			fs.renameSync(tmpPath, this.statePath);
		} finally {
			// Always close the fd
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore close errors */
			}
			// Clean up temp file if rename failed or stale
			try {
				fs.unlinkSync(tmpPath);
			} catch {
				/* ignore */
			}
		}
	}
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}

// ── ExtensionState Core ──

/**
 * Typed get/set for extension state with schema validation and write queue.
 *
 * @typeParam T - Shape of the state object (inferred from schema).
 *
 * @example
 * ```ts
 * const state = new ExtensionState(
 *   new FileStore(),
 *   SessionExtensionsSchema,
 *   ({ error }) => console.warn("State error:", error.message),
 * );
 *
 * const loggerOn = await state.get("logger");
 * await state.set("advice", false);
 * ```
 */
export class ExtensionState<S extends TObject<TProperties>> {
	private readonly store: ExtensionStateStore;
	private readonly schema: S;
	private readonly onError: OnErrorHandler | undefined;
	private writeLock: Promise<void> = Promise.resolve();

	constructor(store: ExtensionStateStore, schema: S, onError?: OnErrorHandler) {
		this.store = store;
		this.schema = schema;
		this.onError = onError;
	}

	/**
	 * Get a typed state value for `key`.
	 * Returns the default value if the key is missing or data is corrupt.
	 */
	async get<K extends keyof Static<S>>(key: K): Promise<Static<S>[K]> {
		const parsed = await this.readWithDefaults();
		return (parsed as Static<S>)[key];
	}

	/**
	 * Set a typed state value for `key` and persist.
	 * Writes are serialized through a promise chain to prevent interleaved
	 * read-modify-write cycles.
	 */
	async set<K extends keyof Static<S>>(key: K, value: Static<S>[K]): Promise<void> {
		const prev = this.writeLock;
		this.writeLock = prev
			.then(async () => {
				const parsed = await this.readWithDefaults();
				(parsed as Record<string, unknown>)[key as string] = value;
				await this.store.write(JSON.stringify(parsed, null, 2) + "\n");
			})
			.catch((err: unknown) => {
				// Reset the write lock so future writes aren't permanently blocked.
				// Without this, a single write failure would break the promise chain
				// and all subsequent set() calls would silently no-op.
				this.writeLock = Promise.resolve();
				throw err;
			});
		return this.writeLock;
	}

	// ── Internal ──

	private async readWithDefaults(): Promise<Record<string, unknown>> {
		try {
			const raw = await this.store.read();
			if (raw === null) {
				return Default(this.schema, {}) as Record<string, unknown>;
			}

			let data: Record<string, unknown>;
			try {
				data = JSON.parse(raw);
			} catch (parseErr: unknown) {
				const error = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
				this.onError?.({ error, rawData: raw });
				return Default(this.schema, {}) as Record<string, unknown>;
			}

			if (data === null || typeof data !== "object" || Array.isArray(data)) {
				const error = new Error("State file contains non-object JSON");
				this.onError?.({ error, rawData: raw });
				return Default(this.schema, {}) as Record<string, unknown>;
			}

			if (!Check(this.schema, data)) {
				const firstError = [...Errors(this.schema, data)][0];
				const message = firstError
					? `${firstError.instancePath} ${firstError.message}`
					: "schema validation failed";
				const error = new Error(`State validation error: ${message}`);
				this.onError?.({ error, rawData: raw });
				// Return all defaults on validation failure — don't propagate invalid values
				return Default(this.schema, {}) as Record<string, unknown>;
			}

			return Default(this.schema, data) as Record<string, unknown>;
		} catch (err: unknown) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.onError?.({ error });
			return Default(this.schema, {}) as Record<string, unknown>;
		}
	}
}

// ── Session Extensions Schema ──

/**
 * Schema for `session-extensions.json`.
 *
 * Both fields are optional booleans defaulting to `true`.
 * Old files missing either key auto-populate defaults without migration.
 */
export const SessionExtensionsSchema = Type.Object({
	advice: Type.Optional(Type.Boolean({ default: true })),
	logger: Type.Optional(Type.Boolean({ default: true })),
});

/** Inferred type: `{ advice: boolean; logger: boolean }`. */
export type SessionExtensions = Static<typeof SessionExtensionsSchema>;
