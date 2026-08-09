// ─── Diagnostics — pure functions for observability ────────────────
// Phase 1: Diagnostic output for event processing errors, idle detection,
// and gap warnings. All functions are pure — no side effects.

// ─── Event Gap Detection ──────────────────────────────────────────

/**
 * Result of a gap detection check.
 */
export interface EventGap {
	/** Elapsed time in milliseconds between now and lastEventTime */
	elapsedMs: number;
	/** Whether the elapsed time strictly exceeds the threshold */
	exceeded: boolean;
}

/**
 * Detect whether the gap since the last event exceeds a threshold.
 * Pure comparison — no formatting, no side effects.
 *
 * Uses strict greater-than (`>`), not `>=`, so exact-boundary
 * (elapsed === thresholdMs) returns `exceeded: false`.
 * Negative elapsed (future lastEventTime) also returns `exceeded: false`.
 *
 * @param now - Current timestamp (ms since epoch)
 * @param lastEventTime - Timestamp of the last received event, or undefined
 * @param thresholdMs - Threshold in milliseconds
 * @returns `{ elapsedMs, exceeded }` — never throws
 */
export function detectEventGap(
	now: number,
	lastEventTime: number | undefined,
	thresholdMs: number,
): EventGap {
	if (lastEventTime === undefined) {
		return { elapsedMs: 0, exceeded: false };
	}
	const elapsedMs = now - lastEventTime;
	return {
		elapsedMs,
		exceeded: elapsedMs > thresholdMs,
	};
}

// ─── Error Notification Context ───────────────────────────────────

/**
 * Build a formatted notification string from an event processing error.
 * Includes event type, error message, and timestamp.
 *
 * @param event - The event that caused the error (any shape)
 * @param error - The error that was thrown
 * @returns Formatted notification string
 */
export function buildErrorNotificationContext(event: unknown, error: unknown): string {
	const eventType =
		event && typeof event === "object" && "type" in event
			? String((event as Record<string, unknown>).type)
			: "unknown";
	const errorMsg = error instanceof Error ? error.message : String(error);
	const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
	return `[${ts}] Event error (${eventType}): ${errorMsg}`;
}
