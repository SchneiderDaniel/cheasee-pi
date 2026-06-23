/**
 * Types for context-info extension
 */

export interface ThresholdEntry {
	maxTokens: number | null;
}

export interface TpsSample {
	time: number;
	cumulativeTokens: number;
}

export interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
	showTimer: boolean;
	showTps: boolean;
	showCache: boolean;
	/** Auto-dismiss welcome banner after N ms. 0 = no timeout (wait for user interaction). */
	welcomeTimeoutMs: number;
}

/**
 * FooterConfig — Data-only interface for footer rendering state.
 *
 * Fields using `{ value: T }` wrappers are mutated in-place from event
 * handlers and read at render time via the same object reference.
 * Adding a new footer field means adding a property here and using it
 * in installFooter() — no call sites change.
 */
export interface FooterConfig {
	worktreeName: string | null;
	thinkingLevel: string;
	tpsSamples: TpsSample[];
	lastComputedTps: { value: number | null };
	lastContextWindow: { value: number | undefined };
	toolCallCount: { value: number };
	cacheRead: number | undefined;
	cacheWrite: number | undefined;
	/** Cache hit rate percentage: cacheRead/(cacheRead+cacheWrite)*100 */
	cacheHitRate: number | undefined;
	/** User-assigned session name from pi.getSessionName() */
	sessionName: string | undefined;
	/** Project trust status from ctx.isProjectTrusted() */
	trustStatus: "trusted" | "untrusted" | undefined;
	sessionId: string;

	// ── Supervisor issue info ────────────────────────────────
	/** Current supervisor issue number (mutable at runtime via value wrapper) */
	issueNumber: { value: number | undefined };
	/** Current supervisor issue repo slug like "owner/repo" (mutable at runtime) */
	issueRepo: { value: string | undefined };
	/** Current supervisor issue title (mutable at runtime) */
	issueTitle: { value: string | undefined };

	// ── Container resource monitoring ────────────────────────
	/** Previous CPU usage in microseconds (from cpu.stat usage_usec) */
	prevCpuUsage: number;
	/** Timestamp of previous CPU sample (ms) */
	prevCpuTime: number;
	/** Number of allocated CPUs for percentage calculation */
	allocatedCpus: number;
	/** Cached container display string, re-read at most every ~1s */
	containerDisplay: { value: string };

	// ── Runtime hooks (set by factory) ───────────────────────
	/** Trigger TUI re-render from external code (e.g., event listeners).
	 *  Set by the footer factory when first called. Avoids re-installing
	 *  the entire footer just to reflect mutated state. */
	_requestRender?: () => void;
}
