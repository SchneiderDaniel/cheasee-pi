// ─── CodeFlow function-count mirror (`Parser.extractOtherLanguages`) ─
// The pinned analyzer (`index.html` `detectPatterns`, ref below) emits both
//   godFiles    = files.filter(f => f.isCode !== false && f.functions.length > 15)
//   vbaGodFiles = files.filter(f => f.isCode !== false && f.functions.length > 20)
// so `VBA God Module` is `God Object` at a higher ceiling, and both read the
// same raw-text parser count. `.py` is scored by the two-line python branch
// (every `def` at any indent, every `class`), every other language by the
// shared `RULES` pass — which also runs *over* `.go` in addition to `GO_RULE`.
// Counts are deduplicated by `name@line`.
//
// This non-test module holds the shared mirror so the `#2004` god-object
// oracle, the `#2006` vba-god-module oracle and any future ceiling share one
// source of the pinned detector. It is not named `*.test.mts`, so
// `node --test` never loads it as a suite.

// The pinned analyzer ref and `codeExts` (`index.html:1093`) are owned by the
// long-file mirror; re-exported so a re-pin updates one literal.
export { ANALYZER_REF, CODE_EXTS } from "./long-file-mirror.mts";
import { CODE_EXTS } from "./long-file-mirror.mts";

// ─── The pinned detector ──────────────────────────────────────────

const RULES: RegExp[] = [
	/(?:public|private|protected|internal|static|final|override|virtual|abstract|async)\s+(?:(?:static|final|override|virtual|abstract|async)\s+)*(?:\w+\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/,
	/(?:suspend\s+)?fun\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/,
	/^\s*def\s+(?:self\s*\.\s*)?([a-zA-Z_][a-zA-Z0-9_]*[?!=]?)/,
	/(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/,
	/(?:public|private|protected|static)?\s*function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/,
	/^(?:static\s+)?(?:inline\s+)?(?:virtual\s+)?(?:\w+\s+)+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^;]*$/,
	/(?:public|private|internal|fileprivate|open)?\s*(?:static\s+)?(?:class\s+)?func\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/,
	/\bdef\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[(\[]/,
	/\bdefp?\s+([a-zA-Z_][a-zA-Z0-9_?!]*)/,
	/(?:local\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_.:]*)\s*\(/,
	/(?:Public|Private|Friend)?\s*(?:Sub|Function)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/i,
];
const C_NEGATIVE = /^\s*(if|for|while|switch|return|sizeof|typeof)/;
const GO_RULE = /^func\s+(?:\([^)]+\)\s*)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;
const PY_DEF = /^\s*(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/;
const PY_CLASS = /^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

/** Count functions exactly the way CodeFlow's headless analyzer does. */
export function countFunctions(src: string, ext: string): number {
	const seen = new Set<string>();
	const add = (name: string | undefined, line: number): void => {
		if (name) seen.add(`${name}@${line}`);
	};
	src.split("\n").forEach((line, idx) => {
		const lineNum = idx + 1;
		let m: RegExpMatchArray | null;
		if (ext === "go" && (m = line.match(GO_RULE))) add(m[1], lineNum);
		if (ext === "py") {
			if ((m = line.match(PY_DEF))) add(m[1], lineNum);
			if ((m = line.match(PY_CLASS))) add(m[1], lineNum);
			return;
		}
		RULES.forEach((rule, i) => {
			if ((m = line.match(rule))) {
				if (i === 5 && C_NEGATIVE.test(line)) return;
				add(i === 9 ? m[1]!.split(/[.:]/).pop() : m[1], lineNum);
			}
		});
	});
	return seen.size;
}

/** The analyzer's `godFiles`/`vbaGodFiles` predicate at an explicit ceiling. */
export function functionCountFlagged(src: string, rel: string, ceiling: number): boolean {
	const ext = rel.split(".").pop()!;
	if (!CODE_EXTS.includes(`.${ext}`)) return false;
	return countFunctions(src, ext) > ceiling;
}
