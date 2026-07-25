/**
 * tsc-checkpoint — TrendTracker: pure bounded-error-count history with trend detection
 *
 * Pure module for tracking error count trends over consecutive compilation cycles.
 * Bounded history prevents unbounded memory growth.
 *
 * This is the deep module the refactoring extracts: one pure interface
 * (push/getTrend) over a bounded array, fully testable without I/O.
 */

import type { DiagnosticTrend } from "./types.ts";

// ponytail: 50 entries keeps recent trend context without unbounded memory growth.
// Increase if per-session trend analysis needs deeper history.
const MAX_TREND_HISTORY = 50;

export class TrendTracker {
	private history: number[] = [];

	/**
	 * Push an error count from a compilation cycle.
	 * Older entries beyond MAX_TREND_HISTORY are evicted.
	 */
	push(errorCount: number): void {
		this.history.push(errorCount);
		if (this.history.length > MAX_TREND_HISTORY) {
			this.history.shift();
		}
	}

	/**
	 * Get the trend between the last two data points.
	 * Returns undefined if fewer than 2 data points exist.
	 */
	getTrend(): DiagnosticTrend | undefined {
		if (this.history.length < 2) return undefined;
		const current = this.history[this.history.length - 1]!;
		const previous = this.history[this.history.length - 2]!;
		const delta = current - previous;
		return {
			current,
			previous,
			direction: delta < 0 ? "improved" : delta > 0 ? "regressed" : "stable",
			delta: Math.abs(delta),
		};
	}

	/** Test-only: get current history length. */
	get historyLength(): number {
		return this.history.length;
	}
}
