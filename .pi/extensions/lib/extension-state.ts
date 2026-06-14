/**
 * ExtensionState — shared file-backed state persistence for extensions
 *
 * Consolidates duplicated writeExtState logic from session-logger and
 * session-advice into a single importable module.
 *
 * Also contains session-level resolver pure functions extracted from
 * caveman/session.ts: resolveSessionLevel, resetSessionLevel,
 * shouldAppendCavemanEntry.
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

export type ExtensionStateValue = boolean | null;

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
export class ExtensionStateError extends Error {
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

/**
 * Create an extension state store with closure-encapsulated state.
 *
 * @param statePath — path to the JSON state file
 */
export function createExtensionStateStore(statePath: string): ExtensionStateStore {
	let state: Record<string, ExtensionStateValue> = {};
	let loaded = false;
	let saveQueue: Promise<void> = Promise.resolve();

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
		const snapshot = JSON.stringify(state, null, 2) + "\n";
		// Chain with catch-guard so a failed task doesn't block subsequent tasks.
		// The returned promise still propagates the error to the caller.
		saveQueue = saveQueue
			.catch(() => {}) // Clear rejection so next task always runs
			.then(async () => {
				try {
					await mkdir(dirname(statePath), { recursive: true });
					await writeFile(statePath, snapshot, "utf8");
				} catch (err: unknown) {
					throw new ExtensionStateError(
						`Failed to write extension state: ${(err as Error).message}`,
						"write",
					);
				}
			});
		return saveQueue;
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

// ===========================================================================
// Session-level resolvers (moved from caveman/session.ts)
// ===========================================================================

import type { Level } from "../caveman/types.ts";
import { LEVELS } from "../caveman/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of session entries that resolveSessionLevel inspects.
 *
 * Accepts a broader type than the pi agent's SessionEntry union so that
 * callers can pass ctx.sessionManager.getEntries() directly without a cast.
 * The function only accesses .type, .customType, and .data,
 * narrowing at runtime to entries matching its contract.
 */
export type SessionEntry = {
	type: string;
	customType?: string;
	data?: unknown;
};

export interface ResolvedSessionLevel {
	level: Level;
	shouldAppendEntry: boolean;
}

// ---------------------------------------------------------------------------
// Resolve session level
// ---------------------------------------------------------------------------

/**
 * Determine the caveman level for the current session based on config
 * and any persisted session entries.
 *
 * @param config — current caveman config (with defaultLevel)
 * @param sessionEntries — entries from session manager
 * @returns resolved level and whether to log an entry
 */
export function resolveSessionLevel(
	config: { defaultLevel: Level },
	sessionEntries: SessionEntry[],
): ResolvedSessionLevel {
	// Check for session-level override first (resuming a session)
	// Iterate backward to find the MOST RECENT caveman-level entry (fixes bug #475)
	for (let i = sessionEntries.length - 1; i >= 0; i--) {
		const entry = sessionEntries[i];
		if (entry.type === "custom" && entry.customType === "caveman-level") {
			const data = entry.data;
			if (
				typeof data === "object" &&
				data !== null &&
				"level" in data &&
				typeof data.level === "string" &&
				LEVELS.includes(data.level as Level)
			) {
				return { level: data.level as Level, shouldAppendEntry: false };
			}
		}
	}

	// New session — apply default from config
	const level = config.defaultLevel;
	const shouldAppendEntry = level !== "off";
	return { level, shouldAppendEntry };
}

// ---------------------------------------------------------------------------
// Reset session level on shutdown
// ---------------------------------------------------------------------------

/**
 * Gate whether to append a caveman-level entry based on project trust.
 *
 * Prevents extension state from leaking into untrusted sessions where
 * session entries are visible to the LLM during context assembly.
 *
 * @returns true only when both conditions are met
 */
export function shouldAppendCavemanEntry(shouldAppendEntry: boolean, isTrusted: boolean): boolean {
	return shouldAppendEntry && isTrusted;
}

/**
 * Reset caveman level to "off" on session shutdown.
 * Prevents stale state from leaking across sessions.
 */
export function resetSessionLevel(_currentLevel: Level): Level {
	return "off";
}
