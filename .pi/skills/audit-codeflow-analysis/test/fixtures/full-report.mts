/**
 * Synthetic 207-fact CodeFlow JSON report — the acceptance shape of #1982.
 *
 * Generated rather than checked in so the per-category distribution stays
 * visible: 193 bug candidates (2 architecture + 13 security + 16 dead-code +
 * 10 duplicate + 145 layer-violation + 7 suggestion), 2 derived size/coupling
 * metrics (chore) and 12 design/anti-patterns (informational/chore). Every fact
 * cites a real checkout file, so `selectCandidates` keeps all 207 and an
 * end-to-end emit writes one candidate per fact.
 */
const REAL_FILE = ".pi/skills/audit-codeflow-analysis/lib/report.ts";

export const FULL_REPORT_TOTALS = { facts: 207, bugCandidates: 193, routed: 14 };

const count = <T,>(n: number, make: (i: number) => T): T[] =>
	Array.from({ length: n }, (_, i) => make(i));

export function buildFullReport(): Record<string, unknown> {
	return {
		architectureIssues: [
			// The live report's over-255-byte title — the ENAMETOOLONG trigger.
			{
				title: `4 Similar Code Blocks with env with unresolved exec ${"word ".repeat(20)}`.trim(),
				affectedFiles: [REAL_FILE],
			},
			{ title: "6 Duplicate Function Names", affectedFiles: [REAL_FILE] },
			{ title: "145 Large Files", affectedFiles: [REAL_FILE] },
			{ title: "7 Highly Coupled Modules", affectedFiles: [REAL_FILE] },
		],
		securityIssues: count(13, (i) => ({
			severity: "high",
			title: `Hardcoded Secret ${i}`,
			path: REAL_FILE,
		})),
		unusedFunctions: count(16, (i) => ({ name: `unusedFn${i}`, file: REAL_FILE })),
		duplicates: count(10, (i) => ({
			type: "code",
			name: `dupBlock${i}`,
			files: [{ file: REAL_FILE }],
		})),
		layerViolations: count(145, (i) => ({
			from: REAL_FILE,
			to: REAL_FILE,
			fromLayer: `layer${i}`,
			toLayer: `ui${i}`,
		})),
		suggestions: count(7, (i) => ({ title: `Split Module ${i}` })),
		patterns: [
			...count(8, (i) => ({ name: `Pattern ${i}`, files: [REAL_FILE] })),
			...count(4, (i) => ({ name: `Anti Pattern ${i}`, isAntiPattern: true, files: [REAL_FILE] })),
		],
	};
}
