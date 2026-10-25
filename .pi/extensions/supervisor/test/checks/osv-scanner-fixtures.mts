export // ═══════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════

const CLEAN_JSON = JSON.stringify({ results: [] });

export const VULNS_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-xxxx-xxxx-xxxx",
							aliases: ["CVE-2024-1111"],
							summary: "Prototype Pollution in lodash",
							database_specific: { severity: "HIGH" },
						},
						{
							id: "GHSA-yyyy-yyyy-yyyy",
							aliases: ["CVE-2024-2222"],
							summary: "Regular Expression DoS in lodash",
							database_specific: { severity: "MEDIUM" },
						},
					],
					groups: [{ ids: ["GHSA-xxxx-xxxx-xxxx"] }, { ids: ["GHSA-yyyy-yyyy-yyyy"] }],
				},
				{
					package: { name: "axios", version: "0.21.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-zzzz-zzzz-zzzz",
							aliases: ["CVE-2024-3333"],
							summary: "Server-Side Request Forgery in axios",
							database_specific: { severity: "CRITICAL" },
						},
					],
					groups: [{ ids: ["GHSA-zzzz-zzzz-zzzz"] }],
				},
			],
		},
		{
			source: { path: "/worktrees/test/Cargo.lock", type: "lockfile" },
			packages: [
				{
					package: { name: "openssl-sys", version: "0.9.60", ecosystem: "crates.io" },
					vulnerabilities: [
						{
							id: "RUSTSEC-2024-0001",
							aliases: ["CVE-2024-4444"],
							summary: "Buffer overflow in openssl-sys",
							database_specific: { severity: "LOW" },
						},
					],
					groups: [{ ids: ["RUSTSEC-2024-0001"] }],
				},
			],
		},
	],
});

export const VULN_MULTI_ALIAS_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "minimist", version: "1.2.5", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-vh95-9grf-7q3r",
							aliases: ["CVE-2021-44906", "GHSA-vh95-9grf-7q3r"],
							summary: "Prototype Pollution in minimist",
							database_specific: { severity: "CRITICAL" },
						},
					],
					groups: [{ ids: ["GHSA-vh95-9grf-7q3r"] }],
				},
			],
		},
	],
});

export const CC_COMMIT_MATCH_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/vendored/curl", type: "source" },
			packages: [
				{
					package: { name: "curl", version: "7.79.0", ecosystem: "c" },
					vulnerabilities: [
						{
							id: "GHSA-cccc-cccc-cccc",
							aliases: ["CVE-2024-5555"],
							summary: "Heap buffer overflow in curl",
							database_specific: { severity: "HIGH" },
						},
					],
					groups: [{ ids: ["GHSA-cccc-cccc-cccc"] }],
				},
			],
		},
	],
});

export const EMPTY_PACKAGES_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [],
		},
	],
});

export const NO_VULNS_PACKAGES_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "lodash", version: "4.17.21", ecosystem: "npm" },
					vulnerabilities: [],
					groups: [],
				},
			],
		},
	],
});

export // ── Issue #1620 fixtures: CVSS-vector severity resolution ─────────
// Real osv.dev records: vector-only (no database_specific.severity),
// GitHub MODERATE vocabulary, severity under affected[], legacy numeric.

/** GHSA-style record: severity only in severity[] as a CVSS_V3 vector. */
const VECTOR_ONLY_CRITICAL_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "axios", version: "0.21.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-vector-only-0001",
							aliases: ["CVE-2024-9991"],
							summary: "Critical vuln with vector-only metadata",
							// No database_specific.severity — severity[] only (osv.dev shape)
							severity: [
								{
									type: "CVSS_V3",
									score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
								},
							],
						},
					],
					groups: [{ ids: ["GHSA-vector-only-0001"] }],
				},
			],
		},
	],
});

export /** Real RUSTSEC-2022-0013 shape: vector-only, C:N/I:N/A:H → 7.5 → HIGH. */
const RUSTSEC_VECTOR_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/Cargo.lock", type: "lockfile" },
			packages: [
				{
					package: { name: "regex", version: "1.5.4", ecosystem: "crates.io" },
					vulnerabilities: [
						{
							id: "RUSTSEC-2022-0013",
							aliases: ["CVE-2022-24713", "GHSA-m5pq-gvj9-9vr8"],
							summary: "Regex DoS",
							severity: [
								{
									type: "CVSS_V3",
									score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
								},
							],
						},
					],
					groups: [{ ids: ["RUSTSEC-2022-0013"] }],
				},
			],
		},
	],
});

export /** GitHub Advisory vocabulary (elliptic GHSA-r9p9-mrjm-926w is MODERATE). */
const MODERATE_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "elliptic", version: "6.5.3", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-r9p9-mrjm-926w",
							aliases: ["CVE-2020-28498"],
							summary: "Elliptic broken crypto",
							database_specific: { severity: "MODERATE" },
							severity: [
								{
									type: "CVSS_V3",
									score: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:H/I:N/A:N",
								},
							],
						},
					],
					groups: [{ ids: ["GHSA-r9p9-mrjm-926w"] }],
				},
			],
		},
	],
});

export /** OSV schema: package-level severity lives under affected[] when set. */
const AFFECTED_ONLY_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "hs-malware-detector", version: "1.0.0", ecosystem: "pip" },
					vulnerabilities: [
						{
							id: "HSEC-2023-0006",
							aliases: [],
							summary: "Malware in PyPI package",
							// No top-level severity — vector only under affected[].severity
							affected: [
								{
									package: { name: "hs-malware-detector", ecosystem: "pip" },
									severity: [
										{
											type: "CVSS_V3",
											score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
										},
									],
								},
							],
						},
					],
					groups: [{ ids: ["HSEC-2023-0006"] }],
				},
			],
		},
	],
});

export /** Severity as ecosystem_specific.severity on the affected entry (RUSTSEC style). */
const AFFECTED_ECO_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/Cargo.lock", type: "lockfile" },
			packages: [
				{
					package: { name: "serde", version: "1.0.0", ecosystem: "crates.io" },
					vulnerabilities: [
						{
							id: "RUSTSEC-2025-0001",
							aliases: [],
							summary: "Severity in ecosystem_specific",
							affected: [
								{
									package: { name: "serde", ecosystem: "crates.io" },
									ecosystem_specific: { severity: "high" },
								},
							],
						},
					],
					groups: [{ ids: ["RUSTSEC-2025-0001"] }],
				},
			],
		},
	],
});

export /** Legacy numeric score record (osv-scanner sometimes emits score: "9.8"). */
const NUMERIC_SCORE_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "legacy-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-numeric-0001",
							aliases: [],
							summary: "Numeric score vuln",
							severity: [{ type: "CVSS_V3", score: "9.8" }],
						},
					],
					groups: [{ ids: ["GHSA-numeric-0001"] }],
				},
			],
		},
	],
});

export /** Fail-closed: a CVSS-typed entry whose score is neither a vector nor a
 * number must stay UNKNOWN — it must NOT fall through to vocabulary mapping.
 * { type: "CVSS_V3", score: "CRITICAL" } previously fabricated CRITICAL. */
const CVSS_TYPE_VOCAB_FABRICATION_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "fabricate-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-fabricate-0001",
							aliases: [],
							summary: "Malformed CVSS_V3 entry with a vocabulary string",
							severity: [{ type: "CVSS_V3", score: "CRITICAL" }],
						},
					],
					groups: [{ ids: ["GHSA-fabricate-0001"] }],
				},
			],
		},
	],
});

export /** affected[] holds same-named packages across ecosystems; severity must come
 * from the entry whose ecosystem matches the scanned package, not the first
 * name match. */
const AFFECTED_ECOSYSTEM_MISMATCH_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/requirements.txt", type: "lockfile" },
			packages: [
				{
					package: { name: "requests", version: "2.0.0", ecosystem: "PyPI" },
					vulnerabilities: [
						{
							id: "PYSEC-2025-0001",
							aliases: [],
							summary: "Per-ecosystem package-level severity",
							affected: [
								{
									package: { name: "requests", ecosystem: "npm" },
									database_specific: { severity: "LOW" },
								},
								{
									package: { name: "requests", ecosystem: "PyPI" },
									database_specific: { severity: "CRITICAL" },
								},
							],
						},
					],
					groups: [{ ids: ["PYSEC-2025-0001"] }],
				},
			],
		},
	],
});

export /** Only a foreign-ecosystem affected entry exists — it must NOT be applied,
 * or cross-ecosystem metadata could downgrade/fabricate a finding. */
const AFFECTED_FOREIGN_ECOSYSTEM_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/requirements.txt", type: "lockfile" },
			packages: [
				{
					package: { name: "requests", version: "2.0.0", ecosystem: "PyPI" },
					vulnerabilities: [
						{
							id: "PYSEC-2025-0002",
							aliases: [],
							summary: "Foreign-ecosystem affected entry only",
							affected: [
								{
									package: { name: "requests", ecosystem: "npm" },
									database_specific: { severity: "CRITICAL" },
								},
							],
						},
					],
					groups: [{ ids: ["PYSEC-2025-0002"] }],
				},
			],
		},
	],
});

export /** Fail-closed: a vector with unknown metric keys or invalid optional
 * values must stay UNKNOWN — it must not compute a valid score from
 * malformed segments and fabricate a CRITICAL finding. */
const MALFORMED_VECTOR_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "malformed-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-malformed-0001",
							aliases: [],
							summary: "Unknown metric key in vector",
							severity: [
								{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/ZZZ:X" },
							],
						},
					],
					groups: [{ ids: ["GHSA-malformed-0001"] }],
				},
				{
					package: { name: "malformed-pkg2", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-malformed-0002",
							aliases: [],
							summary: "Invalid temporal metric value",
							severity: [
								{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:Z" },
							],
						},
					],
					groups: [{ ids: ["GHSA-malformed-0002"] }],
				},
			],
		},
	],
});
