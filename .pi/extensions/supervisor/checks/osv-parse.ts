// ─── OSV JSON → findings ────────────────────────────────────────
// Severity resolution (vulnerability-vs-package matching) and the parse of
// osv-scanner V2 JSON. Split out of osv-severity.ts (issue #2033); the pure
// CVSS arithmetic lives in cvss.ts, the vocabulary in cvss-severity.ts.

import type {
	OsvFinding,
	OsvOutput,
	OsvPackage,
	OsvScanResult,
	OsvVulnerability,
} from "./osv-types.ts";
import { mapSeverityEntry, mapSeverityString } from "./cvss-severity.ts";
import { bucketBySeverity } from "./osv-counts.ts";
import { determineSeverity } from "./osv-vuln-severity.ts";

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
