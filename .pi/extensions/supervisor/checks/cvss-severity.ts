// ─── Severity vocabulary ────────────────────────────────────────
// Mapping from CVSS scores and ecosystem severity strings onto the five
// normalized levels. Split out of osv-severity.ts (issue #2033).

import type { OsvFinding } from "./osv-types.ts";
import { cvss3BaseScore } from "./cvss.ts";

/**
 * Map a database_specific.severity string to our normalized severity.
 * Case-insensitive; covers both the GitHub Advisory vocabulary (which
 * uses MODERATE instead of MEDIUM) and lowercase ecosystem vocabularies
 * (e.g. RUSTSEC "high" / Ubuntu "low").
 */
export function mapSeverityString(s: string | undefined): OsvFinding["severity"] {
	if (!s) return "UNKNOWN";
	switch (s.toUpperCase()) {
		case "CRITICAL":
			return "CRITICAL";
		case "HIGH":
			return "HIGH";
		case "MODERATE":
		case "MEDIUM":
			return "MEDIUM";
		case "LOW":
			return "LOW";
		default:
			return "UNKNOWN";
	}
}

/**
 * Map a numeric base score to severity using the official CVSS v3.1
 * qualitative scale (CRITICAL ≥ 9.0, HIGH ≥ 7.0, MEDIUM ≥ 4.0, LOW > 0).
 * Shared by the vector and numeric paths so identical scores always
 * classify identically. Returns null for scores with no band (≤ 0).
 */
export function severityFromBaseScore(score: number): OsvFinding["severity"] | null {
	if (score >= 9.0) return "CRITICAL";
	if (score >= 7.0) return "HIGH";
	if (score >= 4.0) return "MEDIUM";
	if (score > 0) return "LOW";
	return null;
}

/**
 * Extract severity from a single severity[] entry.
 * CVSS_V3 vector → official base score; legacy numeric score → band;
 * ecosystem vocabulary strings (e.g. Ubuntu "high") → mapSeverityString.
 * Returns null for unparseable input so the caller falls through to UNKNOWN.
 */
export function mapSeverityEntry(entry: {
	type: string;
	score: string;
}): OsvFinding["severity"] | null {
	const type = (entry.type || "").toUpperCase().trim();
	const score = entry.score ?? "";

	// CVSS_V3 vector → official base score. The only allowed numeric fallback
	// is a legacy bare score on a CVSS_V3 entry ({ type: "CVSS_V3", score:
	// "9.8" }), and only within the CVSS 0–10 range — anything else on a
	// CVSS_V3 entry (malformed vector, out-of-range number, vocabulary string)
	// stays UNKNOWN so it can never fabricate a critical finding.
	if (type === "CVSS_V3") {
		const base = cvss3BaseScore(score);
		if (base !== null) return severityFromBaseScore(base);
		if (/^\d+\.?\d*$/.test(score)) {
			const num = parseFloat(score);
			if (num >= 0 && num <= 10) return severityFromBaseScore(num);
		}
		return null;
	}

	// CVSS_V2/V4 vectors use grammars the v3 calculator cannot score; they stay
	// UNKNOWN rather than falling through to vocabulary mapping, which would let
	// e.g. { type: "CVSS_V4", score: "9.8" } fabricate a CRITICAL (fail closed).
	if (/^CVSS_V[24]$/.test(type)) return null;

	// Ecosystem vocabulary (Ubuntu type emits lowercase severity strings)
	const mapped = mapSeverityString(score);
	return mapped === "UNKNOWN" ? null : mapped;
}
