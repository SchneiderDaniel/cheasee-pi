/**
 * Deterministic, LLM-free pre-filter for CodeFlow candidates (issue #2014).
 *
 * `evaluateFastPath` applies the disproof steps of the mechanism rows in
 * `references/known-false-positives.md` and returns a verdict only when the
 * evidence *proves* the finding false. Its single output type is
 * `InvalidVerdict`: `VERDICT: VALID` is not representable here, so a valid
 * finding can never be lost to this module — anything unproven (unknown shape,
 * missing file, unavailable tool, port error, ambiguity) returns `null` and
 * falls through to the LLM validator in `validate-finding.sh`.
 *
 * Everything below is keyed on the analyzer's mis-fire *shape*, never on a
 * concrete repository, path, symbol, owner or snapshot: the shapes repeat
 * across repositories, only their instances differ. `test/fast-path-agnostic`
 * extracts every literal of this file and fails on a path-like token, so the
 * guard cannot rot.
 *
 * Pure domain: no filesystem, process, or CLI import — the evidence arrives
 * through the injected `RepoPort`, which `scripts/fast-path.mts` implements.
 */

import type { IssueFact, Target } from "./report.ts";

/** A declaration node found by an AST search; never comment or string text. */
export interface Declaration {
	file: string;
	/** 1-based line of the declaration. */
	line: number;
	/** Enclosing type/namespace name, or null when it cannot be attributed. */
	owner: string | null;
	/** True when the declaration carries an executable body. */
	hasBody: boolean;
	/** True when the declaration sits in a `declare` context or a `.d.ts`. */
	ambient: boolean;
}

/** One textual occurrence of a symbol. */
export interface Match {
	file: string;
	/** 1-based line of the occurrence. */
	line: number;
	/** The whole line, so the rules can tell code from comment/string ink. */
	text: string;
}

/**
 * Evidence surface injected into the rules. Each method may be sync or async
 * and may throw: a throw means "the evidence is unavailable", which defers the
 * finding to the LLM validator (`evaluateFastPath` never rejects). `grep` with
 * no path searches the whole repository. Implementations must return matches in
 * any order — the rules sort before using them.
 */
export interface RepoPort {
	readFile(path: string): string | null | Promise<string | null>;
	findDeclarations(symbol: string): Declaration[] | Promise<Declaration[]>;
	grep(pattern: string, path?: string): Match[] | Promise<Match[]>;
}

/** The only verdict this module can produce. There is deliberately no `VALID`. */
export interface InvalidVerdict {
	verdict: "INVALID";
	/** Stable rule id, also present in the known-false-positives table. */
	ruleId: string;
	/** The `known-false-positives.md` row this rule applies. */
	row: number;
	reason: string;
	evidence: string;
}

/**
 * The rule catalogue. `classifyKnownNoise` (lib/report.ts) owns the
 * text-provable rows 6/7/9 and runs *before* validation; these rows must stay
 * disjoint from it.
 */
export const FAST_PATH_RULES: readonly { ruleId: string; row: number }[] = [
	{ ruleId: "suggestion-derived-fact", row: 12 },
	{ ruleId: "zero-file-derived-fact", row: 13 },
	{ ruleId: "argv-array-no-shell", row: 5 },
	{ ruleId: "ambient-type-only-member", row: 11 },
	{ ruleId: "phantom-symbol", row: 10 },
	{ ruleId: "indirect-dispatch", row: 8 },
	{ ruleId: "duplicate-same-name", row: 14 },
	{ ruleId: "similar-code-cross-family", row: 15 },
];

// ─── Lexicons ─────────────────────────────────────────────────────

/**
 * TS/JS comment openers are built from code points because the repo-agnostic
 * guard forbids a path separator inside any literal of this file.
 */
const SLASH = String.fromCharCode(47);
const LINE_COMMENT = new RegExp(`${SLASH}${SLASH}`);
const BLOCK_COMMENT = new RegExp(SLASH + "\\*");
const HTML_COMMENT = new RegExp("<!-{2}");
/** A `#` at line start is a comment in the shell/Python/Ruby family. */
const HASH_COMMENT = /^\s*#/;

/** A command-execution finding: the shape the row-5 rule can disprove. */
const COMMAND_EXEC_TITLE = /command\s*(?:execution|injection)|shell\s*(?:command|execution|injection)|child_process/i;
/** An executable shell (a string command or an explicit shell) — never INVALID. */
const SHELL_TRUE = /\bshell\s*:\s*true/;
const EXEC_STRING = /\bexec(?:Sync)?\s*\(/;
const EXEC_CALL = /\b(?:spawn|execFile)\s*\(/g;
/**
 * A spawn/execFile call whose executable is a single string literal directly
 * followed by an argv array. A variable, member access or concatenation in the
 * executable slot may resolve to a shell interpreter at run time, so only this
 * shape is safe to disprove the finding.
 */
const LITERAL_ARGV_CALL = /\b(?:spawn|execFile)\s*\(\s*["'][^"']*["']\s*,\s*\[/g;
/**
 * A shell interpreter named as the executable of a spawn/execFile call: an argv
 * array still reaches a shell interpreter, which evaluates its own arguments.
 * The optional path prefix is matched with `[^"']*` so no path separator appears
 * in a literal (the repo-agnostic guard forbids one).
 */
const SHELL_EXECUTABLE = new RegExp(
	`\\b(?:spawn|execFile)\\s*\\(\\s*["'][^"']*\\b(?:sh|bash|zsh|ksh|dash|ash|fish|csh|tcsh|cmd|powershell|pwsh|busybox)\\b`,
	"i",
);
/** An argv array whose command flag makes a shell evaluate the following string. */
const SHELL_FLAG_ARGV = new RegExp(
	`\\[\\s*["'](?:-c|${SLASH}c|${SLASH}k|-command|-encodedcommand|-commandwithargs)["']`,
	"i",
);
const DIRECT_CALL_AFTER = /^\s*\(/;
const MEMBER_ACCESS_BEFORE = /[.:]{1,2}\s*$/;
/** A type annotation or property-key colon right after a name (`name: T`). */
const KEY_OR_TYPE_AFTER = /^\s*\??\s*:(?!:)/;
/** A default/assignment delimiter right after a name (`name = …`). */
const BINDING_ASSIGN_AFTER = /^\s*=(?!=)/;
/** A declaration keyword right before a name (`function name`, `const name`). */
const BINDING_KEYWORD_BEFORE =
	/\b(?:const|let|var|function|class|import|export|type|interface|enum|namespace|module|declare|using|def|fn|func|struct|impl|trait|param)\s*$/;
/** A function/generator/constructor/catch parameter-list head. */
const PARAM_LIST_HEAD = /\b(?:function|constructor|catch)\s*\*?\s*[A-Za-z0-9_$]*\s*$/;
/** Value-position delimiters: argument, array element, object property, rhs. */
const VALUE_LEFT = /[(,[{=]$/;
const VALUE_RIGHT = /^[)\]},;]/;

/** Names the analyzer's bare-word scanner invents out of a type annotation. */
const BUILTIN_TYPE_TOKENS = new Set([
	"string",
	"str",
	"int",
	"int32",
	"int64",
	"uint",
	"float",
	"float64",
	"bool",
	"boolean",
	"byte",
	"rune",
	"error",
	"any",
	"number",
	"object",
	"unknown",
	"void",
	"nil",
	"null",
	"none",
]);

const EXTENSION = /\.([A-Za-z0-9]+)\s*$/;

/**
 * Language family by extension. `.ts`/`.mts`/`.js`/`.jsx` share one family so a
 * match *across* families cannot be an import-based or copy relationship in one
 * language. An unrecognized extension has no family, which defers.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	ts: "js-ts",
	mts: "js-ts",
	cts: "js-ts",
	tsx: "js-ts",
	js: "js-ts",
	mjs: "js-ts",
	cjs: "js-ts",
	jsx: "js-ts",
	py: "python",
	rs: "rust",
	go: "go",
	sh: "shell",
	bash: "shell",
};

/** A path segment that marks test-only material (fixtures, specs, mocks). */
const TEST_PATH_SEGMENT = /(^|\.)(test|tests|spec|fixtures?|__mocks__)(\.|$)/i;

const SAME_NAME_TITLE = /^Same Name/i;
const SIMILAR_CODE_TITLE = /^Similar Code/i;
const DUPLICATE_NAMES_TITLE = /duplicate\s+\w*\s*names?/i;
const SIMILAR_CODE_TITLE_ANY = /similar code/i;

/** A `name()` title (with or without a `Severity:`/`Label:` prefix). */
const PAREN_TITLE = /^(?:[A-Za-z][A-Za-z ]*:\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\(\)$/;
const LABEL_TITLE = /^[A-Za-z][A-Za-z ]*:\s*([A-Za-z_$][A-Za-z0-9_$]*)$/;

// ─── Shared text helpers ──────────────────────────────────────────

function matchesOf(re: RegExp, text: string): number {
	return (text.match(re) ?? []).length;
}

/**
 * Language family of a path by extension, or null when unrecognized. Exported
 * so the CLI adapter's ast-grep grammar lookup and the rules share one table.
 */
export function languageFamily(path: string): string | null {
	const m = EXTENSION.exec(path.trim());
	return m ? (LANGUAGE_BY_EXTENSION[m[1].toLowerCase()] ?? null) : null;
}

function isTestPath(path: string): boolean {
	return path.split(SLASH).some((segment) => TEST_PATH_SEGMENT.test(segment));
}

/** Drop quoted literals so a `//` inside a URL is not read as a comment. */
export function stripStringLiterals(line: string): string {
	let out = "";
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		out += ch;
	}
	return out;
}

/** True when the quote character occurs an odd number of times (unclosed). */
function insideString(before: string, quote: string): boolean {
	let count = 0;
	for (let i = 0; i < before.length; i++) {
		if (before[i] !== quote) continue;
		if (i > 0 && before[i - 1] === "\\") continue;
		count++;
	}
	return count % 2 === 1;
}

/**
 * True when this occurrence of `symbol` is comment or string ink rather than
 * code. Line-local by design: an occurrence deep inside a multi-line comment
 * reads as code and defers, which is the safe direction.
 * shortcut: a multi-line block comment's interior is not detected, upgrade if a
 * phantom symbol ever only appears there.
 */
function isInk(match: Match, symbol: string): boolean {
	const text = match.text;
	const idx = text.indexOf(symbol);
	if (idx < 0) return false;
	const before = text.slice(0, idx);
	const code = stripStringLiterals(before);
	if (LINE_COMMENT.test(code) || BLOCK_COMMENT.test(code) || HTML_COMMENT.test(text)) return true;
	if (HASH_COMMENT.test(text)) return true;
	return insideString(before, '"') || insideString(before, "'") || insideString(before, "`");
}

/** The bare symbol a finding names, or null when it names none. */
function symbolOf(finding: IssueFact): string | null {
	const target = finding.targets?.find((t): t is Extract<Target, { kind: "symbol" }> => t.kind === "symbol");
	if (target) return target.name;
	const title = finding.title.trim();
	const paren = PAREN_TITLE.exec(title);
	if (paren) return paren[1];
	const label = LABEL_TITLE.exec(title);
	return label ? label[1] : null;
}

/** Sort evidence by location so a verdict never depends on enumeration order. */
function byLocation<T extends { file: string; line: number }>(list: readonly T[]): T[] {
	return [...list].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** The duplicate family a finding belongs to, or null when it is neither. */
function duplicateFamily(finding: IssueFact): "same-name" | "similar-code" | null {
	if (finding.kind === "duplicate") {
		if (SAME_NAME_TITLE.test(finding.title)) return "same-name";
		if (SIMILAR_CODE_TITLE.test(finding.title)) return "similar-code";
		return null;
	}
	if (finding.kind === "architecture") {
		if (SIMILAR_CODE_TITLE_ANY.test(finding.title)) return "similar-code";
		if (DUPLICATE_NAMES_TITLE.test(finding.title)) return "same-name";
	}
	return null;
}

// ─── Rules ────────────────────────────────────────────────────────

interface RuleHit {
	reason: string;
	evidence: string;
}

interface Rule {
	ruleId: string;
	row: number;
	decide(finding: IssueFact, repo: RepoPort): Promise<RuleHit | null>;
}

/**
 * Whether the finding belongs to the unused-function shape rows 8/10/11 key
 * on: a `dead-code` candidate that names a symbol.
 */
function isSymbolFinding(finding: IssueFact): boolean {
	return finding.kind === "dead-code" && symbolOf(finding) !== null;
}

const RULES: readonly Rule[] = [
	{
		ruleId: "suggestion-derived-fact",
		row: 12,
		async decide(finding) {
			if (finding.kind !== "suggestion") return null;
			return {
				reason: "a suggestion is a descriptive derived signal — there is nothing to remediate",
				evidence: `suggestion: ${finding.title}`,
			};
		},
	},
	{
		ruleId: "zero-file-derived-fact",
		row: 13,
		async decide(finding) {
			const targets = finding.targets ?? [];
			if (targets.length > 0 || finding.files.length > 0) return null;
			// A symbol named by the finding (a symbol target or a `name()`/`Label:
			// name` title) is locatable, so this is not the zero-file shape.
			if (symbolOf(finding) !== null) return null;
			return {
				reason: "the fact cites no file and no locatable symbol, so no code can confirm it",
				evidence: `${finding.kind}: ${finding.title} — no target, no cited file`,
			};
		},
	},
	{
		ruleId: "argv-array-no-shell",
		row: 5,
		async decide(finding, repo) {
			if (finding.files.length === 0 || !COMMAND_EXEC_TITLE.test(finding.title)) return null;
			const cited = [...finding.files].sort();
			let calls = 0;
			for (const file of cited) {
				const text = await repo.readFile(file);
				// An unreadable citation proves nothing: defer, never guess.
				if (!text) return null;
				const total = matchesOf(EXEC_CALL, text);
				if (total === 0) return null;
				// Every call must take a string-literal executable and an argv array.
				// An unresolved executable (variable, member, concatenation) may be a
				// shell interpreter, so it is not disproved this way and defers.
				if (matchesOf(LITERAL_ARGV_CALL, text) < total) return null;
				calls += total;
				// Conservative: a shell anywhere in the cited file defers it.
				if (SHELL_TRUE.test(text) || EXEC_STRING.test(text)) return null;
				// A shell interpreter or a `-c` command flag still evaluates its argument.
				if (SHELL_EXECUTABLE.test(text) || SHELL_FLAG_ARGV.test(text)) return null;
			}
			return {
				reason: `every spawn and execFile call in the cited file(s) takes an argv array and no shell: true is set, so no shell interprets a metacharacter`,
				evidence: `${cited.join(", ")} — ${calls} argv-array call(s), no shell: true, no shell-string exec`,
			};
		},
	},
	{
		ruleId: "ambient-type-only-member",
		row: 11,
		async decide(finding, repo) {
			if (!isSymbolFinding(finding)) return null;
			const symbol = symbolOf(finding);
			if (symbol === null) return null;
			const decls = byLocation(await repo.findDeclarations(symbol));
			if (decls.length === 0) return null;
			// Any executable declaration means the code exists at runtime.
			if (decls.some((d) => d.hasBody)) return null;
			if (!decls.every((d) => d.ambient)) return null;
			const first = decls[0] as Declaration;
			return {
				reason: `the only declaration of the symbol is type-only (a declare module or declare global member, or a declaration file) with no runtime body, so it is not executable code`,
				evidence: `${first.file}:${first.line}`,
			};
		},
	},
	{
		ruleId: "phantom-symbol",
		row: 10,
		async decide(finding, repo) {
			if (!isSymbolFinding(finding)) return null;
			const symbol = symbolOf(finding);
			if (symbol === null) return null;
			const decls = await repo.findDeclarations(symbol);
			// A real declaration with a body means a maintainer can act on it.
			if (decls.some((d) => d.hasBody)) return null;
			const occurrences = byLocation(await repo.grep(symbol));
			// Absent everywhere is the producer-filtered shape, not this rule.
			if (occurrences.length === 0) return null;
			if (BUILTIN_TYPE_TOKENS.has(symbol)) {
				// A builtin-looking name is only a phantom when it actually sits in
				// the scanner's type-annotation shape. A language with no known family
				// is not covered by the declaration search and may declare a real
				// function of that name (e.g. a `string()` in PHP), so it defers.
				const annotation = occurrences.find((m) => !isInk(m, symbol) && isTypeAnnotation(m, symbol));
				if (!annotation) return null;
				if (languageFamily(annotation.file) === null) return null;
				return {
					reason: `the "function" name is a builtin type token read out of a type annotation, so it is a scanner artifact rather than a declaration with a body`,
					evidence: `${annotation.file}:${annotation.line} — ${annotation.text.trim()}`,
				};
			}
			if (!occurrences.every((m) => isInk(m, symbol))) return null;
			const first = occurrences[0] as Match;
			return {
				reason: `every occurrence of the symbol sits inside a comment or string literal, so no declaration with a body exists`,
				evidence: `${first.file}:${first.line} — ${first.text.trim()}`,
			};
		},
	},
	{
		ruleId: "indirect-dispatch",
		row: 8,
		async decide(finding, repo) {
			if (!isSymbolFinding(finding)) return null;
			const symbol = symbolOf(finding);
			if (symbol === null) return null;
			const decls = await repo.findDeclarations(symbol);
			// Without a declaration there is nothing to reach indirectly.
			if (decls.length === 0) return null;
			const declarationSites = new Set(decls.map((d) => `${d.file}:${d.line}`));
			const occurrences = byLocation(await repo.grep(symbol)).filter((m) => !isInk(m, symbol));
			// A same-named parameter or local binding can shadow the symbol, so a
			// value-position use may refer to the shadow rather than to the
			// declaration. The reference cannot be attributed: defer, never guess.
			if (occurrences.some((m) => isShadowingBinding(m, symbol, declarationSites))) return null;
			const refs = occurrences.filter((m) => !declarationSites.has(`${m.file}:${m.line}`));
			if (refs.length === 0) return null;
			// Every non-declaration occurrence must be a clear by-name reference. An
			// occurrence that is neither a value-position operand nor a recognized
			// binding (e.g. a parameter declared on its own line) may belong to a
			// shadowing scope the line-local scan cannot see, so the reference is not
			// attributable and the finding defers rather than guess.
			if (refs.some((m) => !isValuePosition(m, symbol))) return null;
			const seam = refs[0] as Match;
			return {
				reason: `the symbol is referenced outside its declaration in value or argument position or through a dispatch seam, so the code is reached indirectly and is not dead`,
				evidence: `${seam.file}:${seam.line} — ${seam.text.trim()}`,
			};
		},
	},
	{
		ruleId: "duplicate-same-name",
		row: 14,
		async decide(finding, repo) {
			if (duplicateFamily(finding) !== "same-name") return null;
			const symbol = symbolOf(finding);
			if (symbol === null) return null;
			const decls = await repo.findDeclarations(symbol);
			const owners = [...new Set(decls.map((d) => d.owner).filter((o): o is string => o !== null))].sort();
			// One owner (or no attributable owner) is a same-type overload, not a duplicate.
			if (owners.length < 2) return null;
			return {
				reason: `the same member name is declared by ${owners.length} distinct enclosing types, which is an intentional per-type method, not duplicated code`,
				evidence: `${symbol} declared by ${owners.join(", ")}`,
			};
		},
	},
	{
		ruleId: "similar-code-cross-family",
		row: 15,
		async decide(finding) {
			if (duplicateFamily(finding) !== "similar-code") return null;
			const files = [...finding.files].sort();
			if (files.length < 2) return null;
			const families = files.map(languageFamily);
			// An unknown extension proves nothing about unrelatedness.
			if (families.some((f) => f === null)) return null;
			const distinct = new Set(families).size;
			if (distinct > 1) {
				return {
					reason: `the cluster members live in ${distinct} distinct language families, so they are textual look-alikes rather than copies of one implementation`,
					evidence: files.join(", "),
				};
			}
			if (!files.every(isTestPath)) return null;
			return {
				reason: `every cluster member is test-fixture material, so the reported similarity is fixture data, not production duplication`,
				evidence: files.join(", "),
			};
		},
	},
];

/**
 * True when the occurrence is a structural reference in value or argument
 * position — the symbol passed by name (`wire(handler)`, `{ handler }`) rather
 * than a binding (parameter, variable, import), a direct call (`handler()`), or
 * a member access (`x.handler`). Comment ink is stripped first, so a
 * `register`/`dispatch` word in trailing prose cannot read as a dispatch seam.
 *
 * A bare name must sit between value delimiters, and every binding shape
 * defers. The earlier "anything that is not a call or a member" test misread a
 * shadowing parameter (`function takes(orphan: () => void) {}`) as a reference
 * and suppressed a genuinely dead function.
 * shortcut: call layouts are read line-locally, so a by-name reference whose
 * delimiters sit on another line defers; upgrade if that gap ever matters.
 */
function isValuePosition(match: Match, symbol: string): boolean {
	const code = stripComment(match.text);
	const idx = code.indexOf(symbol);
	if (idx < 0) return false;
	const before = code.slice(0, idx);
	const after = code.slice(idx + symbol.length);
	// A direct call or a member access is not a by-name reference.
	if (DIRECT_CALL_AFTER.test(after)) return false;
	if (MEMBER_ACCESS_BEFORE.test(before)) return false;
	// A type annotation / property key (`name: T`), a default (`name = …`), or a
	// declaration keyword (`function name`) is a binding, not a reference.
	if (KEY_OR_TYPE_AFTER.test(after) || BINDING_ASSIGN_AFTER.test(after)) return false;
	if (BINDING_KEYWORD_BEFORE.test(before)) return false;
	// A destructuring or import binding (`const { name } = …`) is not a value use.
	if (insideBraceBinding(code, idx)) return false;
	// A function/arrow/method parameter list binds the name, so a parameter can
	// never read as a by-name argument.
	if (insideParameterList(code, idx)) return false;
	return VALUE_LEFT.test(before.replace(/\s+$/, "")) && VALUE_RIGHT.test(after.replace(/^\s+/, ""));
}

/** True when the occurrence sits in a `{ … }` opened by a binding keyword. */
function insideBraceBinding(code: string, idx: number): boolean {
	const open = code.lastIndexOf("{", idx);
	if (open < 0) return false;
	return /\b(?:const|let|var|import|export|declare|using)\s*$/.test(code.slice(0, open));
}

/** Position of the innermost `(` still open at `idx`, or -1 when none is. */
function enclosingParen(code: string, idx: number): number {
	const stack: number[] = [];
	for (let i = 0; i < idx && i < code.length; i++) {
		if (code[i] === "(") stack.push(i);
		else if (code[i] === ")") stack.pop();
	}
	return stack.length > 0 ? (stack[stack.length - 1] as number) : -1;
}

/**
 * True when the occurrence sits inside a function/arrow/method parameter list —
 * a shadowing binding, not a reference to the module-level symbol.
 */
function insideParameterList(code: string, idx: number): boolean {
	const open = enclosingParen(code, idx);
	if (open < 0) return false;
	if (PARAM_LIST_HEAD.test(code.slice(0, open))) return true;
	const close = code.indexOf(")", idx);
	if (close < 0) return false;
	const tail = code.slice(close + 1);
	// `(a, b) => …` and `name(a, b) {` open a parameter list / method body.
	return /^\s*=>/.test(tail) || /^\s*\{/.test(tail);
}

/** A local `const`/`let`/`var` binding keyword right before an assigned name. */
const LOCAL_BINDING_KEYWORD_BEFORE = /\b(?:const|let|var|using)\s*$/;

/**
 * True when this occurrence binds the name in a local scope — a function,
 * arrow or method parameter, a local `const`/`let`/`var`, a destructuring
 * pattern, or an import specifier — rather than referencing the module-level
 * symbol. Such a binding can shadow the candidate, so a value-position use
 * elsewhere cannot be attributed to the declaration and must defer.
 *
 * Declaration sites (already reported by the AST search) are excluded, so the
 * module-level declaration itself never reads as a shadow.
 */
function isShadowingBinding(
	match: Match,
	symbol: string,
	declarationSites: ReadonlySet<string>,
): boolean {
	if (declarationSites.has(`${match.file}:${match.line}`)) return false;
	const code = stripComment(match.text);
	const idx = code.indexOf(symbol);
	if (idx < 0) return false;
	const before = code.slice(0, idx);
	const after = code.slice(idx + symbol.length);
	// A member access names another object's member, not a local binding.
	if (MEMBER_ACCESS_BEFORE.test(before)) return false;
	if (insideParameterList(code, idx)) return true;
	if (insideBraceBinding(code, idx)) return true;
	return BINDING_ASSIGN_AFTER.test(after) && LOCAL_BINDING_KEYWORD_BEFORE.test(before);
}

/**
 * True when the occurrence sits in a type-annotation position — the shape the
 * analyzer's bare-word scanner reads a symbol name out of: `name: T` / `): T`,
 * or a Go-style named result/parameter (`(name T)`).
 */
function isTypeAnnotation(match: Match, symbol: string): boolean {
	const code = stripComment(match.text);
	const idx = code.indexOf(symbol);
	if (idx < 0) return false;
	const before = code.slice(0, idx);
	const after = code.slice(idx + symbol.length);
	if (KEY_OR_TYPE_AFTER.test(after) || /:\s*$/.test(before)) return true;
	return /\b[A-Za-z_$][A-Za-z0-9_$]*\s+$/.test(before) && /^\s*[,)]/.test(after);
}

/** Drop any trailing line comment or block comment from one line of code. */
function stripComment(line: string): string {
	const code = stripStringLiterals(line);
	const block = code.search(BLOCK_COMMENT);
	const kept = block >= 0 ? code.slice(0, block) : code;
	const lineComment = kept.search(LINE_COMMENT);
	return lineComment >= 0 ? kept.slice(0, lineComment) : kept;
}

/**
 * Apply the deterministic known-FP rules to one finding.
 *
 * Returns an `InvalidVerdict` only when the evidence proves the finding false;
 * `null` means "defer to the LLM validator" (unmatched shape, ambiguity, missing
 * evidence, or a `RepoPort` failure). Never rejects. `warn` receives any port
 * error so a deferral is observable instead of silent.
 */
export async function evaluateFastPath(
	finding: IssueFact,
	repo: RepoPort,
	warn?: (error: unknown) => void,
): Promise<InvalidVerdict | null> {
	try {
		for (const rule of RULES) {
			const hit = await rule.decide(finding, repo);
			if (hit) {
				return {
					verdict: "INVALID",
					ruleId: rule.ruleId,
					row: rule.row,
					reason: hit.reason,
					evidence: hit.evidence,
				};
			}
		}
		return null;
	} catch (error) {
		// Fail open: unavailable evidence always defers to the LLM validator.
		warn?.(error);
		return null;
	}
}
