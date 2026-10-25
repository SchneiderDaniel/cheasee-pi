// ─── CVSS v3.0/3.1 base score (pure) ────────────────────────────
// FIRST.org specification arithmetic only: no I/O, no OSV shapes. Split out
// of osv-severity.ts (issue #2033); re-exported from there.

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
export function roundupToTenth(score: number): number {
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
	const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
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
