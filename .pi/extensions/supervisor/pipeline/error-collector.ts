// ─── ErrorCollector ───────────────────────────────────────────────
// Centralized error aggregation to eliminate silent failures.
// Threaded through the supervisor pipeline: every catch site pushes
// structured records to the collector. At transition points, render
// a user-visible warnings panel.
//
// Architecture (issue #2098 split):
//   - STORAGE + ingestion logging live here (push/flush/hasErrors)
//   - PANEL RENDERING lives in pipeline/error-panel.ts (pure, logger-free)
//   - `enabled: false` disables collection entirely (the default singleton)
//   - Module-level singleton accessor (getErrorCollector/setErrorCollector)
//   - resetErrorCollector() for test isolation

import { getDebugLogger } from "../lib/debug.ts";
import { MAX_MESSAGE_LENGTH, renderErrorPanel } from "./error-panel.ts";

/** A single structured error/warning record */
export interface ErrorRecord {
	source: string;
	severity: "warn" | "error";
	message: string;
	timestamp: number;
}

/** Options bag for the collector. */
export interface ErrorCollectorOptions {
	/** When false the collector stores nothing and logs nothing. Default true. */
	enabled?: boolean;
}

/**
 * ErrorCollector — centralized error collector for the supervisor pipeline.
 *
 * Usage:
 *   const collector = new ErrorCollector();
 *   collector.push("helpers", "error", "Something went wrong");
 *   collector.toNotificationBlock(); // Returns markdown panel
 */
export class ErrorCollector {
	private records: ErrorRecord[] = [];
	private readonly enabled: boolean;

	constructor(opts: ErrorCollectorOptions = {}) {
		this.enabled = opts.enabled ?? true;
	}

	/**
	 * Push a new error/warning record.
	 *
	 * The full message is persisted to the debug log here — at ingestion, once
	 * per record — because the rendered panel only shows a summary and the real
	 * failure reason must survive for diagnosis. Rendering is side-effect free,
	 * so repeated renders cannot duplicate this entry.
	 */
	push(source: string, severity: "warn" | "error", message: string): void {
		if (!this.enabled) return;
		this.records.push({
			source,
			severity,
			message,
			timestamp: Date.now(),
		});
		if (message.length > MAX_MESSAGE_LENGTH) {
			getDebugLogger().warn("error-collector", "notification message truncated", {
				source,
				message,
			});
		}
	}

	/**
	 * Flush (return and remove) all records for a given source.
	 * Returns empty array if no records match.
	 */
	flush(source: string): ErrorRecord[] {
		if (!this.enabled) return [];
		const matched: ErrorRecord[] = [];
		const remaining: ErrorRecord[] = [];
		for (const record of this.records) {
			if (record.source === source) {
				matched.push(record);
			} else {
				remaining.push(record);
			}
		}
		this.records = remaining;
		return matched;
	}

	/**
	 * Returns true if any records have been collected.
	 */
	hasErrors(): boolean {
		return this.enabled && this.records.length > 0;
	}

	/**
	 * Build a user-visible markdown warnings panel from the collected records.
	 * Pure delegation to renderErrorPanel — safe to call repeatedly.
	 */
	toNotificationBlock(): string {
		return renderErrorPanel(this.records);
	}

	/**
	 * Return total record count.
	 */
	get size(): number {
		return this.enabled ? this.records.length : 0;
	}

	/**
	 * Return a copy of all records.
	 */
	get all(): ErrorRecord[] {
		return [...this.records];
	}
}

// ─── Singleton ─────────────────────────────────────────────────────

/** A collector that collects nothing — the default until a pipeline installs one. */
function createDisabledErrorCollector(): ErrorCollector {
	return new ErrorCollector({ enabled: false });
}

/** The current singleton instance */
let currentCollector: ErrorCollector = createDisabledErrorCollector();

/**
 * Get the current global ErrorCollector instance.
 * Returns a no-op collector by default.
 */
export function getErrorCollector(): ErrorCollector {
	return currentCollector;
}

/**
 * Set the global ErrorCollector instance.
 * Used by pipeline handler to set the active collector.
 */
export function setErrorCollector(collector: ErrorCollector): void {
	currentCollector = collector;
}

/**
 * Reset the global ErrorCollector to a fresh instance.
 * Useful for test isolation.
 */
export function resetErrorCollector(): void {
	currentCollector = createDisabledErrorCollector();
}
