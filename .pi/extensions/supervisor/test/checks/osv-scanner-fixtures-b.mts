export /** Fail-closed: unparseable severity must stay UNKNOWN, never fabricated. */
const UNPARSEABLE_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "old-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "CVE-2009-0001",
							aliases: [],
							summary: "CVSS v2 vector — documented gap",
							severity: [{ type: "CVSS_V2", score: "AV:L/AC:M/Au:N/C:N/I:P/A:C" }],
						},
					],
					groups: [{ ids: ["CVE-2009-0001"] }],
				},
			],
		},
	],
});

export /** Fail-closed: the legacy bare-number fallback applies only to CVSS_V3
 * entries and only within the CVSS 0–10 range. Unsupported CVSS types with a
 * numeric score and out-of-range scores must stay UNKNOWN, never CRITICAL. */
const CVSS_NUMERIC_BOUNDARY_JSON = JSON.stringify({
	results: [
		{
			source: { path: "/worktrees/test/package-lock.json", type: "lockfile" },
			packages: [
				{
					package: { name: "v4-numeric-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-v4-numeric-0001",
							aliases: [],
							summary: "CVSS_V4 legacy numeric score",
							severity: [{ type: "CVSS_V4", score: "9.8" }],
						},
					],
					groups: [{ ids: ["GHSA-v4-numeric-0001"] }],
				},
				{
					package: { name: "v2-numeric-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-v2-numeric-0002",
							aliases: [],
							summary: "CVSS_V2 legacy numeric score",
							severity: [{ type: "CVSS_V2", score: "9.8" }],
						},
					],
					groups: [{ ids: ["GHSA-v2-numeric-0002"] }],
				},
				{
					package: { name: "over-range-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-over-range-0003",
							aliases: [],
							summary: "CVSS_V3 score above the 0–10 range",
							severity: [{ type: "CVSS_V3", score: "11" }],
						},
					],
					groups: [{ ids: ["GHSA-over-range-0003"] }],
				},
				{
					package: { name: "range-boundary-pkg", version: "1.0.0", ecosystem: "npm" },
					vulnerabilities: [
						{
							id: "GHSA-range-boundary-0004",
							aliases: [],
							summary: "CVSS_V3 score at the top of the valid range",
							severity: [{ type: "CVSS_V3", score: "10" }],
						},
					],
					groups: [{ ids: ["GHSA-range-boundary-0004"] }],
				},
			],
		},
	],
});
