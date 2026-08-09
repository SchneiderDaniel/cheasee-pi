// ─── ErrorCollector ───────────────────────────────────────────────
// Centralized error aggregation to eliminate silent failures.
// Threaded through the supervisor pipeline: every catch site pushes
// structured records to the collector. At transition points, render
// a user-visible warnings panel.
//
// Architecture:
//   - ErrorCollector class with push/flush/hasErrors/toNotificationBlock
//   - Module-level singleton accessor (getErrorCollector/setErrorCollector)
//   - NoopErrorCollector default singleton (collects nothing)
//   - resetErrorCollector() for test isolation

/** A single structured error/warning record */
export interface ErrorRecord {
	source: string;
	severity: "warn" | "error";
	message: string;
	timestamp: number;
}

/** Maximum message length before truncation in toNotificationBlock */
const MAX_MESSAGE_LENGTH = 200;

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

	/**
	 * Push a new error/warning record.
	 */
	push(source: string, severity: "warn" | "error", message: string): void {
		this.records.push({
			source,
			severity,
			message,
			timestamp: Date.now(),
		});
	}

	/**
	 * Flush (return and remove) all records for a given source.
	 * Returns empty array if no records match.
	 */
	flush(source: string): ErrorRecord[] {
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
		return this.records.length > 0;
	}

	/**
	 * Build a user-visible markdown warnings panel.
	 * Groups records by source, with errors before warnings within each group.
	 * Messages are truncated to MAX_MESSAGE_LENGTH characters.
	 * Returns empty string if no records.
	 */
	toNotificationBlock(): string {
		if (this.records.length === 0) return "";

		const lines: string[] = [];
		lines.push("## ⚠️ Warnings");
		lines.push("");

		// Group by source
		const groups = new Map<string, ErrorRecord[]>();
		for (const record of this.records) {
			const group = groups.get(record.source);
			if (group) {
				group.push(record);
			} else {
				groups.set(record.source, [record]);
			}
		}

		// Render each source group: errors first, then warnings
		for (const [source, records] of groups) {
			lines.push(`### ${source}`);
			lines.push("");

			// Sort: errors before warnings
			const sorted = [...records].sort((a, b) => {
				if (a.severity !== b.severity) {
					return a.severity === "error" ? -1 : 1;
				}
				return a.timestamp - b.timestamp;
			});

			for (const record of sorted) {
				const severityLabel = record.severity === "error" ? "ERROR" : "WARN";
				const truncated =
					record.message.length > MAX_MESSAGE_LENGTH
						? record.message.slice(0, MAX_MESSAGE_LENGTH) + "..."
						: record.message;
				lines.push(`- **\`[${severityLabel}]\`** ${truncated}`);
			}

			lines.push("");
		}

		// Summary line
		const errorCount = this.records.filter((r) => r.severity === "error").length;
		const warnCount = this.records.filter((r) => r.severity === "warn").length;
		const parts: string[] = [];
		if (errorCount > 0) parts.push(`${errorCount} error(s)`);
		if (warnCount > 0) parts.push(`${warnCount} warning(s)`);
		lines.push(`**${parts.join(", ")}** — see above for details.`);

		return lines.join("\n");
	}

	/**
	 * Return total record count.
	 */
	get size(): number {
		return this.records.length;
	}

	/**
	 * Return a copy of all records.
	 */
	get all(): ErrorRecord[] {
		return [...this.records];
	}
}

// ─── Singleton ─────────────────────────────────────────────────────

/** Default no-op singleton — collects nothing, all methods are no-ops */
class NoopErrorCollector extends ErrorCollector {
	override push(_source: string, _severity: "warn" | "error", _message: string): void {
		// no-op
	}

	override flush(_source: string): ErrorRecord[] {
		return [];
	}

	override hasErrors(): boolean {
		return false;
	}

	override toNotificationBlock(): string {
		return "";
	}

	override get size(): number {
		return 0;
	}

	override get all(): ErrorRecord[] {
		return [];
	}
}

/** The current singleton instance */
let currentCollector: ErrorCollector = new NoopErrorCollector();

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
	currentCollector = new NoopErrorCollector();
}
