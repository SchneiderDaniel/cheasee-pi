// ─── Severity census ────────────────────────────────────────────
// Count findings per severity level. Split out of osv-severity.ts
// (issue #2033); re-exported from there.

import type { OsvFinding, OsvScanResult } from "./osv-types.ts";

/**
 * Count findings by severity level.
 */
export function bucketBySeverity(findings: OsvFinding[]): OsvScanResult["counts"] {
	const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
	for (const f of findings) {
		switch (f.severity) {
			case "CRITICAL":
				counts.critical++;
				break;
			case "HIGH":
				counts.high++;
				break;
			case "MEDIUM":
				counts.medium++;
				break;
			case "LOW":
				counts.low++;
				break;
			default:
				counts.unknown++;
				break;
		}
	}
	return counts;
}
