// ─── OSV Severity + JSON Parsing (pure) ─────────────────────────────
// Split out of osv-scanner.ts (issue #2005 Long File refactor). Pure
// functions only — no I/O, no osv-scanner invocation. osv-scanner.ts keeps
// runVulnScan/buildVulnContext and re-exports these names, so no public
// surface changes.

// ─── Types ──────────────────────────────────────────────────────────

export interface OsvFinding {
	/** Primary vulnerability ID (e.g. GHSA-xxxx-xxxx-xxxx) */
	id: string;
	/** All known aliases (CVE-xxxx, RUSTSEC-xxxx, etc.) */
	aliases: string[];
	/** Severity level mapped from CVSS or database_specific */
	severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
	/** Name of the affected package */
	packageName: string;
	/** Version string of the affected package */
	packageVersion: string;
	/** Ecosystem identifier (npm, pip, Go, crates.io, etc.) */
	ecosystem: string;
	/** Lockfile/manifest path where the package was found */
	sourceFile: string;
	/** Short vulnerability summary */
	summary: string;
	/** Whether this is a C/C++ commit-level heuristic match (less reliable) */
	isCcCommitMatch: boolean;
}

export interface OsvScanResult {
	status: "clean" | "vulns_found" | "error" | "no_osv_scanner" | "no_lockfiles";
	findings: OsvFinding[];
	counts: {
		critical: number;
		high: number;
		medium: number;
		low: number;
		unknown: number;
	};
	/** Human-readable message (error detail or summary) */
	message?: string;
	/** Whether any findings are C/C++ commit-level matches (less reliable) */
	ccFindingsFlagged: boolean;
}

// ─── osv-scanner V2 JSON Output Types ──────────────────────────────

interface OsvPackage {
	name: string;
	version: string;
	ecosystem: string;
}

interface OsvVulnerability {
	id: string;
	aliases?: string[];
	summary?: string;
	details?: string;
	database_specific?: {
		severity?: string;
	};
	severity?: Array<{
		type: string;
		score: string;
	}>;
	affected?: OsvAffectedEntry[];
}

/** One entry of the OSV `affected[]` array (osv.dev schema). */
interface OsvAffectedEntry {
	package?: {
		name?: string;
		ecosystem?: string;
	};
	severity?: Array<{
		type: string;
		score: string;
	}>;
	database_specific?: {
		severity?: string;
	};
	ecosystem_specific?: {
		severity?: string;
	};
}

interface OsvGroup {
	ids: string[];
	aliases?: string[];
}

interface OsvPackageResult {
	package: OsvPackage;
	vulnerabilities?: OsvVulnerability[];
	groups?: OsvGroup[];
}

interface OsvSource {
	path: string;
	type: string;
}

interface OsvResult {
	source: OsvSource;
	packages: OsvPackageResult[];
}

interface OsvOutput {
	results?: OsvResult[];
}

// ─── Severity Mapping Helpers ──────────────────────────────────────

/**
 * Map a database_specific.severity string to our normalized severity.
 * Case-insensitive; covers both the GitHub Advisory vocabulary (which
 * uses MODERATE instead of MEDIUM) and lowercase ecosystem vocabularies
 * (e.g. RUSTSEC "high" / Ubuntu "low").
 */
function mapSeverityString(s: string | undefined): OsvFinding["severity"] {
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

// ─── CVSS v3.0/3.1 Base Score (FIRST.org specification) ───────────

// Metric weights per the CVSS v3.1 Specification Document.
const CVSS_AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const CVSS_AC: Record<string, number> = { L: 0.77, H: 0.44 };
const CVSS_UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CVSS_PR_UNCHANGED_SCOPE: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const CVSS_PR_CHANGED_SCOPE: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const CVSS_IMPACT: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };
const CVSS_BASE_METRICS = ["AV", "AC", "PR", "UI", "S", "C", "I", "A"] as const;

// Whitelist of every valid CVSS v3.0/3.1 metric name and its allowed values,
// per the FIRST.org specification. Base metrics are required; temporal
// (E/RL/RC) and environmental (MAV/MAC/MPR/MUI/MS/MC/MI/MA/CR/IR/AR) metrics
// are optional and may carry "X" (Not Defined). Anything outside this table is
// malformed — accept it and unparseable metadata could fabricate a CRITICAL.
const CVSS_V3_METRIC_VALUES: Record<string, ReadonlySet<string>> = {
	AV: new Set(["N", "A", "L", "P"]),
	AC: new Set(["L", "H"]),
	PR: new Set(["N", "L", "H"]),
	UI: new Set(["N", "R"]),
	S: new Set(["U", "C"]),
	C: new Set(["H", "L", "N"]),
	I: new Set(["H", "L", "N"]),
	A: new Set(["H", "L", "N"]),
	E: new Set(["X", "U", "P", "F", "H"]),
	RL: new Set(["X", "O", "T", "W", "U"]),
	RC: new Set(["X", "U", "R", "C"]),
	MAV: new Set(["X", "N", "A", "L", "P"]),
	MAC: new Set(["X", "L", "H"]),
	MPR: new Set(["X", "N", "L", "H"]),
	MUI: new Set(["X", "N", "R"]),
	MS: new Set(["X", "U", "C"]),
	MC: new Set(["X", "N", "L", "H"]),
	MI: new Set(["X", "N", "L", "H"]),
	MA: new Set(["X", "N", "L", "H"]),
	CR: new Set(["X", "L", "M", "H"]),
	IR: new Set(["X", "L", "M", "H"]),
	AR: new Set(["X", "L", "M", "H"]),
};

/** Round up to one decimal place — the rounding CVSS mandates for scores. */
function roundupToTenth(score: number): number {
	return Math.ceil(score * 10 - 0.00001) / 10;
}

/**
 * Compute the CVSS v3.0/3.1 base score from a vector string
 * (e.g. "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" → 9.8).
 *
 * Segments are tokenized as `/KEY:VALUE` pairs (not matched as one
 * contiguous string — the defect that made the old vector branch
 * unreachable), so metrics may appear in any order and optional trailing
 * temporal metrics (e.g. log4j's "/E:H") are simply ignored.
 * Every key and value is validated against the CVSS v3 whitelist — unknown
 * metric names or values (ZZZ:X, E:Z) are rejected as malformed.
 *
 * Returns null for anything that is not a well-formed v3.0/3.1 vector
 * (v2/v4 vectors, plain numbers, garbage) so callers fall through.
 */
export function cvss3BaseScore(vector: string): number | null {
	if (!/^CVSS:3\.[01]\//.test(vector)) return null;

	const kv: Record<string, string> = {};
	for (const seg of vector.split("/").slice(1)) {
		const m = /^([A-Za-z]{1,3}):([A-Za-z]+)$/.exec(seg);
		if (!m) return null;
		const key = m[1]!.toUpperCase();
		const value = m[2]!.toUpperCase();
		const allowed = CVSS_V3_METRIC_VALUES[key];
		if (!allowed || !allowed.has(value)) return null; // unknown metric / invalid value
		if (key in kv) return null; // duplicate metric
		kv[key] = value;
	}

	// All eight base metrics are required; temporal/environmental are optional.
	for (const key of CVSS_BASE_METRICS) {
		if (!(key in kv)) return null;
	}

	const scopeChanged = kv["S"] === "C";
	if (!scopeChanged && kv["S"] !== "U") return null;

	const av = CVSS_AV[kv["AV"]];
	const ac = CVSS_AC[kv["AC"]];
	const ui = CVSS_UI[kv["UI"]];
	const pr = (scopeChanged ? CVSS_PR_CHANGED_SCOPE : CVSS_PR_UNCHANGED_SCOPE)[kv["PR"]];
	const c = CVSS_IMPACT[kv["C"]];
	const i = CVSS_IMPACT[kv["I"]];
	const a = CVSS_IMPACT[kv["A"]];
	if (
		av === undefined ||
		ac === undefined ||
		ui === undefined ||
		pr === undefined ||
		c === undefined ||
		i === undefined ||
		a === undefined
	) {
		return null;
	}

	const iss = 1 - (1 - c) * (1 - i) * (1 - a);
	const impact = scopeChanged
		? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
		: 6.42 * iss;
	const exploitability = 8.22 * av * ac * pr * ui;

	let base: number;
	if (impact <= 0) {
		base = 0;
	} else if (scopeChanged) {
		base = Math.min(1.08 * (impact + exploitability), 10);
	} else {
		base = Math.min(impact + exploitability, 10);
	}

	return roundupToTenth(base);
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
function mapSeverityEntry(entry: { type: string; score: string }): OsvFinding["severity"] | null {
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

/**
 * Determine severity for a vulnerability from available metadata.
 * Priority: top-level database_specific.severity → top-level severity[]
 * → matching affected[] entry (database_specific / ecosystem_specific /
 * severity[]) → UNKNOWN. Package-level resolution catches records that
 * carry severity only under affected[] per the OSV schema.
 */
function determineSeverity(vuln: OsvVulnerability, pkg: OsvPackage): OsvFinding["severity"] {
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

/**
 * Check if a vulnerability is a C/C++ commit-level heuristic match.
 * C/C++ scanning uses commit hashes and `determineversion` heuristic,
 * which is less reliable than lockfile-based scanning.
 */
function isCcCommitLevelMatch(pkg: OsvPackage): boolean {
	return pkg.ecosystem === "c" || pkg.ecosystem === "c++";
}

// ─── Pure Function: parseOsvJson ───────────────────────────────────

/**
 * Parse osv-scanner V2 JSON output from stdout.
 * Returns OsvScanResult with extracted findings.
 *
 * @param stdout - Raw stdout from osv-scanner (JSON blob)
 * @returns Parsed OsvScanResult
 */
export function parseOsvJson(stdout: string | null | undefined): OsvScanResult {
	if (!stdout || stdout.trim() === "") {
		return {
			status: "error",
			findings: [],
			counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
			ccFindingsFlagged: false,
			message: "Empty output from osv-scanner",
		};
	}

	let parsed: OsvOutput;
	try {
		parsed = JSON.parse(stdout) as OsvOutput;
	} catch (err: unknown) {
		return {
			status: "error",
			findings: [],
			counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
			ccFindingsFlagged: false,
			message: `Failed to parse osv-scanner output: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const results = parsed.results;
	if (!results || results.length === 0) {
		return {
			status: "clean",
			findings: [],
			counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
			ccFindingsFlagged: false,
		};
	}

	const findings: OsvFinding[] = [];

	for (const result of results) {
		const sourceFile = result.source.path;
		const packages = result.packages || [];

		for (const pkgResult of packages) {
			const pkg = pkgResult.package;
			const vulns = pkgResult.vulnerabilities || [];

			for (const vuln of vulns) {
				const severity = determineSeverity(vuln, pkg);

				findings.push({
					id: vuln.id,
					aliases: vuln.aliases || [],
					severity,
					packageName: pkg.name,
					packageVersion: pkg.version,
					ecosystem: pkg.ecosystem,
					sourceFile,
					summary: vuln.summary || vuln.details || "",
					isCcCommitMatch: isCcCommitLevelMatch(pkg),
				});
			}
		}
	}

	if (findings.length === 0) {
		return {
			status: "clean",
			findings: [],
			counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
			ccFindingsFlagged: false,
		};
	}

	return {
		status: "vulns_found",
		findings,
		counts: bucketBySeverity(findings),
		ccFindingsFlagged: findings.some((f) => f.isCcCommitMatch),
	};
}

// ─── Pure Function: bucketBySeverity ───────────────────────────────

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
