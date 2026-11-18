// ─── Error Panel (issue #2098) ───────────────────────────────────
// Pure markdown presentation for collected error/warning records.
//
// Split out of pipeline/error-collector.ts: storage (and the one ingestion
// side effect) stays there, rendering lives here and touches no logger, so
// rendering the same records twice can never duplicate log lines. Enforced by
// github-split-boundaries.test.mts and error-panel.test.mts.

import type { ErrorRecord } from "./error-collector.ts";

/** Maximum message length before the panel summarizes a message. */
export const MAX_MESSAGE_LENGTH = 200;

/**
 * Summarize a record message for the compact panel — never head-truncate
 * the actionable tail:
 * 1. Keep from the `remediation:` marker onward (pushBranch stamps it;
 *    action-first so the panel shows what to do, not the truncated head).
 * 2. Else keep the trailing parenthesized clause (e.g. the remote-rejected
 *    reason, which lands past the 200-char cut for long branch names).
 * 3. Else head-truncate at MAX_MESSAGE_LENGTH.
 * Full messages beyond MAX_MESSAGE_LENGTH are persisted to the debug log at
 * ingestion time (ErrorCollector.push).
 */
export function summarizeForPanel(message: string): string {
	const remediationIdx = message.indexOf("remediation:");
	if (remediationIdx >= 0) {
		return message.slice(remediationIdx);
	}
	if (message.length <= MAX_MESSAGE_LENGTH) {
		return message;
	}
	const tail = message.match(/\([^()]*\)\s*$/);
	if (tail) {
		const clause = tail[0].trim();
		return clause.length <= MAX_MESSAGE_LENGTH
			? clause
			: clause.slice(0, MAX_MESSAGE_LENGTH) + "...";
	}
	return message.slice(0, MAX_MESSAGE_LENGTH) + "...";
}

/**
 * Build a user-visible markdown warnings panel.
 * Groups records by source, with errors before warnings within each group.
 * Messages are summarized to MAX_MESSAGE_LENGTH characters.
 * Returns an empty string when there is nothing to show.
 */
export function renderErrorPanel(records: ErrorRecord[]): string {
	if (records.length === 0) return "";

	const lines: string[] = [];
	lines.push("## ⚠️ Warnings");
	lines.push("");

	// Group by source
	const groups = new Map<string, ErrorRecord[]>();
	for (const record of records) {
		const group = groups.get(record.source);
		if (group) {
			group.push(record);
		} else {
			groups.set(record.source, [record]);
		}
	}

	// Render each source group: errors first, then warnings
	for (const [source, groupRecords] of groups) {
		lines.push(`### ${source}`);
		lines.push("");

		// Sort: errors before warnings
		const sorted = [...groupRecords].sort((a, b) => {
			if (a.severity !== b.severity) {
				return a.severity === "error" ? -1 : 1;
			}
			return a.timestamp - b.timestamp;
		});

		for (const record of sorted) {
			const severityLabel = record.severity === "error" ? "ERROR" : "WARN";
			lines.push(`- **\`[${severityLabel}]\`** ${summarizeForPanel(record.message)}`);
		}

		lines.push("");
	}

	// Summary line
	const errorCount = records.filter((r) => r.severity === "error").length;
	const warnCount = records.filter((r) => r.severity === "warn").length;
	const parts: string[] = [];
	if (errorCount > 0) parts.push(`${errorCount} error(s)`);
	if (warnCount > 0) parts.push(`${warnCount} warning(s)`);
	lines.push(`**${parts.join(", ")}** — see above for details.`);

	return lines.join("\n");
}
