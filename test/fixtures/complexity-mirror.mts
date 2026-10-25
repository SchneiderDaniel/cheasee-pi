// ─── CodeFlow "High Complexity Files" metric mirror ───────────────
// The pinned analyzer (`index.html` `calcComplexity`, ref below) emits
//   architectureIssues["N High Complexity Files"]
//     = analyzed.filter(f => f.complexity.level === "critical")
// with `calcComplexity(content) = 1 + Σ(branch-regex hits)` over the RAW file
// text — comments and string literals included — and `critical ⇔ score > 30`.
// The 24 regexes below are `patterns.concat(pyPatterns, rbPatterns)` at the
// pinned ref: 9 JS/C, 10 Python, 5 Ruby.
//
// This non-test module holds the shared mirror so the per-family oracle
// (`test/complexity-refactor-2003.test.mts`, `test/complexity-refactor-2033.test.mts`)
// and the recorded-envelope oracle (`test/codeflow-run-analysis.test.mts`) apply
// the exact same detector. It is not named `*.test.mts`, so `node --test` never
// loads it as a suite.
//
// The pinned analyzer ref and `codeExts` are owned by the long-file mirror and
// re-exported here, so a re-pin updates one literal.

export { ANALYZER_REF, CODE_EXTS } from "./long-file-mirror.mts";
import { CODE_EXTS } from "./long-file-mirror.mts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── The pinned detector ──────────────────────────────────────────

const JS_PATTERNS = [
	/\bif\s*\(/g,
	/\belse\s+if\s*\(/g,
	/\bwhile\s*\(/g,
	/\bfor\s*\(/g,
	/\bcase\s+/g,
	/\bcatch\s*\(/g,
	/\?\s*[^:]+\s*:/g,
	/&&/g,
	/\|\|/g,
];
const PY_PATTERNS = [
	/\bif\s+[^(]/g,
	/\belif\s+/g,
	/\bwhile\s+[^(]/g,
	/\bfor\s+\w+\s+in\s+/g,
	/\bexcept\s*/g,
	/\bwith\s+/g,
	/\band\b/g,
	/\bor\b/g,
	/\bif\s+.+\s+else\s+/g,
	/\bfor\s+.+\s+in\s+[^\n]*\]/g,
];
const RB_PATTERNS = [/\belsif\s+/g, /\bunless\s+/g, /\bwhen\s+/g, /\brescue\b/g, /\buntil\s+/g];

/** The 24 branch regexes `calcComplexity` iterates, in analyzer order. */
export const CALC_PATTERNS: RegExp[] = JS_PATTERNS.concat(PY_PATTERNS, RB_PATTERNS);

/** `critical ⇔ score > 30` — the ceiling the metric counts. */
export const CEILING = 30;

export interface Complexity {
	score: number;
	level: "low" | "medium" | "high" | "critical";
}

/** `Parser.calcComplexity(content)` — the non-script-container path. */
export function calcComplexity(content: string): Complexity {
	if (!content) return { score: 0, level: "low" };
	let complexity = 1;
	for (const p of CALC_PATTERNS) {
		const m = content.match(p);
		if (m) complexity += m.length;
	}
	let level: Complexity["level"] = "low";
	if (complexity > 30) level = "critical";
	else if (complexity > 20) level = "high";
	else if (complexity > 10) level = "medium";
	return { score: complexity, level };
}

/** The analyzer's complexity predicate, including the `isCode` gate. */
export function complexityFlagged(src: string, rel: string): boolean {
	if (!CODE_EXTS.includes(`.${rel.split(".").pop()}`)) return false;
	return calcComplexity(src).level === "critical";
}

/** The pinned metric measured over one tracked tree. */
export interface ComplexityMeasurement {
	/** Tracked file count (`git ls-files` at the measured tree). */
	files: number;
	/** Tracked files whose extension the analyzer scores (`isCode !== false`). */
	codeFiles: number;
	/** Scored paths still over the ceiling, sorted and duplicate-free. */
	flagged: string[];
}

/**
 * Measure the tracked files under `root` exactly the way the pinned analyzer
 * measures its snapshot: enumerate the tracked tree, score only members of
 * `CODE_EXTS`, and flag any whose raw-text branch count exceeds the ceiling.
 * The delivered tree is measured at test time, so a recorded envelope cannot
 * drift from the source it describes.
 */
export function measureComplexity(root: string): ComplexityMeasurement {
	const files = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
	const flagged: string[] = [];
	let codeFiles = 0;
	for (const rel of files) {
		if (!CODE_EXTS.includes(`.${rel.split(".").pop()}`)) continue;
		codeFiles++;
		if (complexityFlagged(readFileSync(resolve(root, rel), "utf-8"), rel)) flagged.push(rel);
	}
	return { files: files.length, codeFiles, flagged: flagged.sort() };
}
