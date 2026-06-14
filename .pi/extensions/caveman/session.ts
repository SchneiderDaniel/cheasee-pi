/**
 * Session-level resolver — re-export from shared ExtensionState module
 *
 * Backward-compatibility re-export. All session-level logic now lives in
 * .pi/extensions/lib/extension-state.ts to share between extensions.
 *
 * Importers should migrate to import directly from
 * ".pi/extensions/lib/extension-state.ts" for new code.
 */

export {
	resolveSessionLevel,
	resetSessionLevel,
	shouldAppendCavemanEntry,
} from "../lib/extension-state.ts";

export type { SessionEntry, ResolvedSessionLevel } from "../lib/extension-state.ts";
