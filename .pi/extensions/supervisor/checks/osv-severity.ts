// ─── OSV Severity + JSON Parsing (pure) ─────────────────────────────
// Split out of osv-scanner.ts (issue #2005); split again by responsibility
// (issue #2033): CVSS arithmetic in cvss.ts, the severity vocabulary in
// cvss-severity.ts, OSV JSON parsing in osv-parse.ts, the shapes in
// osv-types.ts. This module is the barrel — names are re-exported explicitly
// so osv-scanner.ts and its tests are untouched.

export type { OsvFinding, OsvScanResult } from "./osv-types.ts";
export { cvss3BaseScore } from "./cvss.ts";
export { severityFromBaseScore } from "./cvss-severity.ts";
export { parseOsvJson } from "./osv-parse.ts";
export { bucketBySeverity } from "./osv-counts.ts";
