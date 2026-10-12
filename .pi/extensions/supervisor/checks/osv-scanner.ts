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
import { parseOsvJson, type OsvFinding, type OsvScanResult } from "./osv-severity.ts";
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

// Pure severity/parse helpers extracted to osv-severity.ts (issue #2005).
// Explicit named re-exports keep the checks surface stable.
export {
	bucketBySeverity,
	cvss3BaseScore,
	parseOsvJson,
	severityFromBaseScore,
	type OsvFinding,
	type OsvScanResult,
} from "./osv-severity.ts";
