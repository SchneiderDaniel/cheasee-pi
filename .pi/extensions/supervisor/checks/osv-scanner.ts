// ─── OSV Scanner Vulnerability Gate ─────────────────────────────────
// Pre-audit gate that runs osv-scanner V2 on the worktree to find
// known CVEs in project dependencies across all ecosystems (npm, pip,
// go, maven, cargo, etc.).
//
// Uses osv-scanner V2 CLI: `scan source --recursive --format json`
// Returns structured result passed to the auditor as context.
// Non-blocking by default; opt-in blocking via config.vulnGateBlocking.
//
// osv-scanner exit codes: 0=clean, 1=vulns_found, 127=error, 128=no_pkgs
// Stderr is suppressed (2>/dev/null) — JSON output is on stdout only.

import { type ExecFn, isExecutableNotFound } from "./shared.ts";

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
 *
 * Returns null for anything that is not a well-formed v3.0/3.1 vector
 * (v2/v4 vectors, plain numbers, garbage) so callers fall through.
 */
export function cvss3BaseScore(vector: string): number | null {
	if (!/^CVSS:3\.[01]\//.test(vector)) return null;

	const kv: Record<string, string> = {};
	for (const seg of vector.split("/").slice(1)) {
		const m = /^([A-Za-z]{1,3}):([A-Za-z]{1,2})$/.exec(seg);
		if (!m) return null;
		const key = m[1]!.toUpperCase();
		if (key in kv) return null; // duplicate metric
		kv[key] = m[2]!.toUpperCase();
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

	// CVSS_V3 vector → official base score
	if (type === "CVSS_V3") {
		const base = cvss3BaseScore(score);
		if (base !== null) return severityFromBaseScore(base);
	}

	// Legacy numeric score (osv-scanner sometimes emits { type: "CVSS_V3", score: "9.8" })
	if (/^\d+\.?\d*$/.test(score)) {
		return severityFromBaseScore(parseFloat(score));
	}

	// A CVSS-typed entry that parsed as neither vector nor number stays UNKNOWN:
	// vocabulary mapping is only valid for non-CVSS types, and treating e.g.
	// { type: "CVSS_V3", score: "CRITICAL" } as vocabulary would fabricate a
	// critical finding and trip the blocking gate (fail closed).
	if (/^CVSS_V[234]$/.test(type)) return null;

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

// ─── Severity Label Lookup ────────────────────────────────────────

/** Presentation labels for severity levels with emoji indicators. */
const SEV_LABELS: Record<OsvFinding["severity"], string> = {
	CRITICAL: "🔴 Critical",
	HIGH: "🟠 High",
	MEDIUM: "🟡 Medium",
	LOW: "🟢 Low",
	UNKNOWN: "⚪ Unknown",
} as const;

// ─── Pure Function: buildVulnContext ───────────────────────────────

/**
 * Build a formatted string from OsvScanResult for injection into auditor task context.
 * Returns human-readable markdown.
 */
export function buildVulnContext(result: OsvScanResult): string {
	if (result.status === "no_osv_scanner") {
		return "osv-scanner not installed. Skipping vulnerability check.";
	}

	if (result.status === "no_lockfiles") {
		return "No lockfiles found. Skipping vulnerability check.";
	}

	if (result.status === "error") {
		return `Vulnerability scan failed: ${result.message || "Unknown error"}`;
	}

	if (result.status === "clean") {
		return "**OSV Vulnerability Scan:** No vulnerabilities found.";
	}

	// vulns_found
	const lines: string[] = [];
	lines.push(`**OSV Vulnerability Scan:** ${result.findings.length} vulnerability(ies) found`);
	lines.push("");

	const c = result.counts;
	const parts: string[] = [];
	if (c.critical > 0) parts.push(`🔴 ${c.critical} critical`);
	if (c.high > 0) parts.push(`🟠 ${c.high} high`);
	if (c.medium > 0) parts.push(`🟡 ${c.medium} medium`);
	if (c.low > 0) parts.push(`🟢 ${c.low} low`);
	if (c.unknown > 0) parts.push(`⚪ ${c.unknown} unknown`);
	if (parts.length > 0) {
		lines.push(`**Severity breakdown:** ${parts.join(", ")}`);
		lines.push("");
	}

	// Group findings by severity for readability
	const severityOrder: OsvFinding["severity"][] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];
	for (const sev of severityOrder) {
		const sevFindings = result.findings.filter((f) => f.severity === sev);
		if (sevFindings.length === 0) continue;

		const sevLabel = SEV_LABELS[sev];

		lines.push(`### ${sevLabel}`);
		lines.push("");
		for (const finding of sevFindings) {
			const aliasStr = finding.aliases.length > 0 ? ` (${finding.aliases.join(", ")})` : "";
			lines.push(`- **${finding.id}**${aliasStr} — ${finding.summary || "No summary"}`);
			lines.push(
				`  - Package: \`${finding.packageName}@${finding.packageVersion}\` (${finding.ecosystem})`,
			);
			lines.push(`  - Source: \`${finding.sourceFile}\``);
			if (finding.isCcCommitMatch) {
				lines.push(`  - ⚠️ C/C++ commit-level heuristic match — may be less reliable`);
			}
			lines.push("");
		}
	}

	if (result.ccFindingsFlagged) {
		lines.push(
			"> **Note:** Some findings are C/C++ commit-level heuristic matches. These may be less reliable than lockfile-based findings.",
		);
		lines.push("");
	}

	lines.push(
		`Found in ${result.findings.map((f) => f.sourceFile).filter((v, i, a) => a.indexOf(v) === i).length} source file(s).`,
	);

	return lines.join("\n");
}

// ─── Main Orchestration: runVulnScan ───────────────────────────────

/**
 * Options for runVulnScan.
 */
export interface VulnScanOptions {
	/** Timeout in seconds for the osv-scanner call (default: 60) */
	timeoutSec?: number;
	/** Path to osv-scanner.toml config file (optional) */
	configPath?: string;
}

/**
 * Run osv-scanner vulnerability scan on the worktree.
 *
 * Steps:
 * 1. Run `osv-scanner scan source --recursive --format json <worktreePath>`
 * 2. Check exit code: 0=clean, 1=vulns, 127=error, 128=no packages
 * 3. Parse JSON output
 * 4. Return structured result
 *
 * Stderr is suppressed (2>/dev/null) — JSON output is on stdout only.
 * ENOENT → graceful degradation (no_osv_scanner).
 *
 * @param exec - Exec function (from pi.exec or mock)
 * @param worktreePath - Path to the worktree
 * @param opts - Scan options (timeout, config path)
 * @returns OsvScanResult
 */
export async function runVulnScan(
	exec: ExecFn,
	worktreePath: string,
	opts: VulnScanOptions = {},
): Promise<OsvScanResult> {
	const timeoutMs = (opts.timeoutSec ?? 60) * 1000;

	// Build args: scan source --recursive --format json <worktreePath>
	const args: string[] = ["scan", "source", "--recursive", "--format", "json"];

	// Optional config file
	if (opts.configPath) {
		args.push("--config", opts.configPath);
	}

	args.push(worktreePath);

	// Execute osv-scanner
	let result: { code: number; stdout: string; stderr: string };
	try {
		result = await exec("osv-scanner", args, {
			timeout: timeoutMs,
		});
	} catch (err: unknown) {
		// ENOENT → osv-scanner not installed
		if (isExecutableNotFound(err)) {
			return {
				status: "no_osv_scanner",
				findings: [],
				counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
				ccFindingsFlagged: false,
			};
		}
		// Other exec error
		const msg = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			findings: [],
			counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
			ccFindingsFlagged: false,
			message: `osv-scanner execution failed: ${msg}`,
		};
	}

	// Handle exit codes
	switch (result.code) {
		case 0: {
			// Clean — but parse JSON to confirm no findings
			const parsed = parseOsvJson(result.stdout);
			if (parsed.status === "error" && result.stdout && result.stdout.trim().length > 0) {
				// Non-empty stdout that failed to parse — propagate error
				return parsed;
			}
			if (parsed.status === "vulns_found") {
				return parsed; // Exit code 0 but findings found (edge case)
			}
			return {
				status: "clean",
				findings: [],
				counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
				ccFindingsFlagged: false,
			};
		}
		case 1: {
			// Vulnerabilities found — parse JSON
			const parsed = parseOsvJson(result.stdout);
			if (parsed.status === "vulns_found" || parsed.status === "clean") {
				return parsed;
			}
			// Parse failed — return error
			return {
				status: "error",
				findings: [],
				counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
				ccFindingsFlagged: false,
				message: parsed.message || "Failed to parse osv-scanner vulnerability output",
			};
		}
		case 127: {
			// General error
			return {
				status: "error",
				findings: [],
				counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
				ccFindingsFlagged: false,
				message: `osv-scanner error: ${result.stderr?.trim() || "Unknown error (exit 127)"}`,
			};
		}
		case 128: {
			// No packages found (no lockfiles detected)
			return {
				status: "no_lockfiles",
				findings: [],
				counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
				ccFindingsFlagged: false,
				message: result.stderr?.trim() || "No packages found in worktree",
			};
		}
		default: {
			// Unexpected exit code
			return {
				status: "error",
				findings: [],
				counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
				ccFindingsFlagged: false,
				message: `osv-scanner returned unexpected exit code ${result.code}: ${result.stderr?.trim() || "Unknown"}`,
			};
		}
	}
}
