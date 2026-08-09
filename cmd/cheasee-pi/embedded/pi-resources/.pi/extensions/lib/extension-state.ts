/**
 * ExtensionState — shared file-backed state persistence for extensions
 *
 * Consolidates duplicated writeExtState logic from session-logger and
 * session-advice into a single importable module.
 *

 * Architecture:
 * - Closure-based factory (see config.ts pattern)
 * - Injectable statePath for test isolation
 * - Sequential write queue prevents partial writes
 * - Typed error surfacing (not silent catch)
 * - No dependencies on extension modules — pure types + I/O only
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ===========================================================================
// Extension state store
// ===========================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExtensionStateValue = boolean | null;

export interface ExtensionStateStore {
	/** Load state from disk (caches after first call). */
	ensureStateLoaded(): Promise<void>;
	/** Get full state snapshot (immutable copy). */
	getState(): Record<string, ExtensionStateValue>;
	/** Replace entire state. */
	setState(state: Record<string, ExtensionStateValue>): void;
	/** Persist current in-memory state to disk. */
	saveState(): Promise<void>;
	/** Get all keys. */
	getKeys(): string[];
	/** Set a single key. null value clears the key. */
	setKey(key: string, value: ExtensionStateValue): void;
	/** Get a single key. Returns undefined if unset. */
	getKey(key: string): ExtensionStateValue | undefined;
}

/** Typed error for extension state operations. */
class ExtensionStateError extends Error {
	/** Which step failed. */
	step: "read" | "write" | "parse";

	constructor(message: string, step: "read" | "write" | "parse") {
		super(message);
		this.name = "ExtensionStateError";
		this.step = step;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Global write queue shared across all store instances.
// Prevents cross-instance races when two extensions write the same file.
let globalWriteQueue: Promise<void> = Promise.resolve();

/**
 * Create an extension state store with closure-encapsulated state.
 *
 * @param statePath — path to the JSON state file
 */
export function createExtensionStateStore(statePath: string): ExtensionStateStore {
	let state: Record<string, ExtensionStateValue> = {};
	let loaded = false;

	const ensureStateLoaded = async (): Promise<void> => {
		if (loaded) return;
		try {
			const raw = await readFile(statePath, "utf8");
			state = JSON.parse(raw);
			// Validate it's a plain object
			if (typeof state !== "object" || state === null || Array.isArray(state)) {
				state = {};
			}
		} catch (err: unknown) {
			// File missing (ENOENT) or corrupt JSON (SyntaxError) — start with empty state
			// Any other error (permissions, etc.) also starts with empty state
			state = {};
		}
		loaded = true; // Mark as loaded regardless — in-memory state is authoritative
	};

	const saveState = async (): Promise<void> => {
		// Chain onto global write queue so ALL store instances share one
		// serialized pipeline. This prevents cross-instance races where two
		// stores writing the same file overwrite each other's keys.
		const prevQueue = globalWriteQueue;
		globalWriteQueue = prevQueue
			.catch(() => {}) // Clear rejection so next task always runs
			.then(async () => {
				try {
					// Read-modify-write: preserve keys from other store instances.
					// Read current file, merge in-memory state on top, then write.
					let current: Record<string, ExtensionStateValue> = {};
					try {
						const raw = await readFile(statePath, "utf8");
						current = JSON.parse(raw);
						if (typeof current !== "object" || current === null || Array.isArray(current)) {
							current = {};
						}
					} catch {
						// File missing or corrupt — start fresh
					}

					const merged = { ...current, ...state };
					const snapshot = JSON.stringify(merged, null, 2) + "\n";
					await mkdir(dirname(statePath), { recursive: true });
					await writeFile(statePath, snapshot, "utf8");
				} catch (err: unknown) {
					throw new ExtensionStateError(
						`Failed to write extension state: ${(err as Error).message}`,
						"write",
					);
				}
			});
		return globalWriteQueue;
	};

	return {
		ensureStateLoaded,
		getState: () => ({ ...state }),
		setState: (newState: Record<string, ExtensionStateValue>) => {
			state = { ...newState };
		},
		saveState,
		getKeys: () => Object.keys(state),
		setKey: (key: string, value: ExtensionStateValue) => {
			if (value === null) {
				delete state[key];
			} else {
				state[key] = value;
			}
		},
		getKey: (key: string) => state[key],
	};
}
