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

/** Exec function type for subprocess calls (3-field return — code, stdout, stderr) */
export type ExecFn = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

import { isExecutableNotFound } from "./shared.ts";

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
 */
function mapSeverityString(s: string | undefined): OsvFinding["severity"] {
	if (!s) return "UNKNOWN";
	switch (s.toUpperCase()) {
		case "CRITICAL":
			return "CRITICAL";
		case "HIGH":
			return "HIGH";
		case "MEDIUM":
			return "MEDIUM";
		case "LOW":
			return "LOW";
		default:
			return "UNKNOWN";
	}
}

/**
 * Extract severity from CVSS score string (e.g. "CVSS:3.1/AV:N/.../C:H/I:H/A:H").
 * Used as fallback when database_specific.severity is absent.
 */
function mapCvssToSeverity(cvssScore: string): OsvFinding["severity"] | null {
	// Try to extract CVSS base score from vector string
	const cvssMatch = cvssScore.match(/CVSS:[34]\.[01]\/AV:[NALP]\/AC:[LH]\/PR:[NLH]\/[UCI]:[NLH]/);
	if (cvssMatch) {
		// Parse the vector for severity components (C/I/A)
		const impactHigh = (cvssScore.match(/C:[HALN]/)?.[0] || "").includes("H");
		const impactCritical = (cvssScore.match(/C:[HALN]/)?.[0] || "").includes("H") && 
		                       (cvssScore.match(/A:[HALN]/)?.[0] || "").includes("H");
		if (impactCritical) return "HIGH";
		if (impactHigh) return "MEDIUM";
		return "LOW";
	}

	// Try to extract numeric CVSS score from severity array
	// osv-scanner sometimes includes severity as { type: "CVSS_V3", score: "9.8" }
	const numericMatch = cvssScore.match(/^(\d+\.?\d*)$/);
	if (numericMatch) {
		const score = parseFloat(numericMatch[1]);
		if (score >= 9.0) return "CRITICAL";
		if (score >= 7.0) return "HIGH";
		if (score >= 4.0) return "MEDIUM";
		if (score > 0) return "LOW";
	}

	return null;
}

/**
 * Determine severity for a vulnerability from available metadata.
 * Priority: database_specific.severity → CVSS array → UNKNOWN.
 */
function determineSeverity(vuln: OsvVulnerability): OsvFinding["severity"] {
	// First: database_specific.severity (most common in osv-scanner output)
	const dbSeverity = mapSeverityString(vuln.database_specific?.severity);
	if (dbSeverity !== "UNKNOWN") return dbSeverity;

	// Second: CVSS severity scores
	if (vuln.severity && vuln.severity.length > 0) {
		for (const sv of vuln.severity) {
			const mapped = mapCvssToSeverity(sv.score);
			if (mapped !== null) return mapped;
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
				const severity = determineSeverity(vuln);

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
	lines.push(
		`**OSV Vulnerability Scan:** ${result.findings.length} vulnerability(ies) found`,
	);
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

		const sevLabel = sev === "CRITICAL" ? "🔴 Critical" :
			sev === "HIGH" ? "🟠 High" :
			sev === "MEDIUM" ? "🟡 Medium" :
			sev === "LOW" ? "🟢 Low" :
			"⚪ Unknown";

		lines.push(`### ${sevLabel}`);
		lines.push("");
		for (const finding of sevFindings) {
			const aliasStr = finding.aliases.length > 0
				? ` (${finding.aliases.join(", ")})`
				: "";
			lines.push(
				`- **${finding.id}**${aliasStr} — ${finding.summary || "No summary"}`,
			);
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
		lines.push("> **Note:** Some findings are C/C++ commit-level heuristic matches. These may be less reliable than lockfile-based findings.");
		lines.push("");
	}

	lines.push(`Found in ${result.findings.map((f) => f.sourceFile).filter((v, i, a) => a.indexOf(v) === i).length} source file(s).`);

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
	const args: string[] = [
		"scan", "source",
		"--recursive",
		"--format", "json",
	];

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
