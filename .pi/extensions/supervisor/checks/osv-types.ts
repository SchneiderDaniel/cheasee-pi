// ─── OSV types ──────────────────────────────────────────────────
// The normalized finding/result types and the osv-scanner V2 JSON shapes.
// Split out of osv-severity.ts (issue #2033); re-exported from there.

// ─── Normalized findings ────────────────────────────────────────────

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

// ─── osv-scanner V2 JSON output shapes ──────────────────────────────

export interface OsvPackage {
	name: string;
	version: string;
	ecosystem: string;
}

export interface OsvVulnerability {
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

export interface OsvOutput {
	results?: OsvResult[];
}
