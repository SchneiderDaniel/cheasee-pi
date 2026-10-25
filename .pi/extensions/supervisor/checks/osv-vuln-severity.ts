// ─── Vulnerability-vs-package severity resolution ───────────────
// Which metadata a finding's severity comes from, in OSV's documented order:
// top-level database_specific → top-level severity[] → the matching affected[]
// entry → UNKNOWN. Split out of osv-severity.ts (issue #2033).

import type { OsvFinding, OsvPackage, OsvVulnerability } from "./osv-types.ts";
import { mapSeverityEntry, mapSeverityString } from "./cvss-severity.ts";

/**
 * Determine severity for a vulnerability from available metadata.
 * Priority: top-level database_specific.severity → top-level severity[]
 * → matching affected[] entry (database_specific / ecosystem_specific /
 * severity[]) → UNKNOWN. Package-level resolution catches records that
 * carry severity only under affected[] per the OSV schema.
 */
export function determineSeverity(vuln: OsvVulnerability, pkg: OsvPackage): OsvFinding["severity"] {
	// First: database_specific.severity (most common in osv-scanner output)
	const dbSeverity = mapSeverityString(vuln.database_specific?.severity);
	if (dbSeverity !== "UNKNOWN") return dbSeverity;

	// Second: top-level CVSS severity scores
	if (vuln.severity) {
		for (const entry of vuln.severity) {
			const mapped = mapSeverityEntry(entry);
			if (mapped !== null) return mapped;
		}
	}

	// Third: package-level severity — OSV schema keeps these only on
	// affected[] when they are set (top-level severity must then be absent).
	// Match ecosystem when the affected entry declares one, so same-named
	// packages in different ecosystems never share severity metadata.
	const affected = (vuln.affected || []).find((entry) => {
		const p = entry.package;
		if (!p || p.name !== pkg.name) return false;
		if (p.ecosystem && pkg.ecosystem) {
			return p.ecosystem.toLowerCase() === pkg.ecosystem.toLowerCase();
		}
		return true;
	});
	if (affected) {
		const affectedDb = mapSeverityString(affected.database_specific?.severity);
		if (affectedDb !== "UNKNOWN") return affectedDb;

		const affectedEco = mapSeverityString(affected.ecosystem_specific?.severity);
		if (affectedEco !== "UNKNOWN") return affectedEco;

		if (affected.severity) {
			for (const entry of affected.severity) {
				const mapped = mapSeverityEntry(entry);
				if (mapped !== null) return mapped;
			}
		}
	}

	return "UNKNOWN";
}
