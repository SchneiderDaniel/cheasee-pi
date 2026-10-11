/**
 * Repo-agnostic guard for the deterministic known-FP pre-filter (issue #2014).
 *
 * The fast path is shared: other repositories run this skill under the same
 * toolchain, so the *matched* rules must key on the analyzer's mis-fire shape,
 * never on a concrete file, symbol, owner or snapshot of one analyzed repo.
 * This test is the regression check for that constraint:
 *
 *  - every literal in `lib/fast-path.ts` is a pattern/lexicon/rule-id token: no
 *    path separator, no tracked path or basename, no owner/repo, no ISO
 *    timestamp, no hex snapshot id;
 *  - the mechanism-table region of `known-false-positives.md` carries no such
 *    instance either, still carries the mechanism lexicon, and maps every
 *    fast-path row to a rule id that exists in `lib/fast-path.ts`;
 *  - the concrete instances live only under `## Verified instances`.
 *
 * Run with:
 *   node --experimental-strip-types --test test/fast-path-agnostic.test.mts
 */

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, it } from "node:test";

import { FAST_PATH_RULES } from "../.pi/skills/audit-codeflow-analysis/lib/fast-path.ts";

const ROOT = resolve(import.meta.dirname, "..");
const RULE_SOURCE_PATH = resolve(ROOT, ".pi/skills/audit-codeflow-analysis/lib/fast-path.ts");
const DOCS_PATH = resolve(ROOT, ".pi/skills/audit-codeflow-analysis/references/known-false-positives.md");

const RULE_SOURCE = readFileSync(RULE_SOURCE_PATH, "utf-8");
const DOCS = readFileSync(DOCS_PATH, "utf-8");

const OWNER_REPO = "SchneiderDaniel/cheasee-pi";
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
/** A snapshot/worktree id: 8+ hex characters. */
const SNAPSHOT_ID = /\b[0-9a-f]{8,}\b/;

/** Every tracked path and basename of this checkout, the instance vocabulary. */
function trackedPaths(): { paths: Set<string>; basenames: Set<string> } {
	const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf-8" })
		.split("\n")
		.filter((l) => l !== "");
	const paths = new Set(out);
	const names = new Set(out.map((p) => basename(p)));
	return { paths, basenames: names };
}

/**
 * The basenames the *analyzed* repository contributes. A basename that some file
 * outside the skill also carries is only forbidden when no skill file carries it:
 * the docs legitimately name their own `lib/report.ts`, and that self-reference is
 * the skill's infrastructure contract, not a rule instance.
 */
function analyzedBasenames(): Set<string> {
	const own = ".pi/skills/audit-codeflow-analysis/";
	const all = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf-8" })
		.split("\n")
		.filter((l) => l !== "");
	const foreign = new Set(all.filter((p) => !p.startsWith(own)).map((p) => basename(p)));
	const skills = new Set(all.filter((p) => p.startsWith(own)).map((p) => basename(p)));
	return new Set([...foreign].filter((name) => !skills.has(name)));
}

interface Literal {
	text: string;
	kind: "string" | "regex";
	/** 1-based line, so a failure names the offending literal. */
	line: number;
}

/**
 * Extract string and regex literals from TypeScript source: comments, import
 * specifiers and the regex-vs-division ambiguity are handled by tracking the
 * previous significant character (a regex can only start where a value is
 * expected).
 */
function extractLiterals(source: string): Literal[] {
	const out: Literal[] = [];
	let i = 0;
	let line = 1;
	let previousSignificant = "";
	let statement = "";
	const push = (text: string, kind: Literal["kind"], startLine: number): void => {
		out.push({ text, kind, line: startLine });
	};
	while (i < source.length) {
		const ch = source[i] as string;
		const next = source[i + 1];
		if (ch === "\n") {
			line++;
			statement = "";
			i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
				if (source[i] === "\n") line++;
				i++;
			}
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			const startLine = line;
			// An import/export specifier names a module, not a rule instance.
			const specifier = /\b(from|import|require)\s*$/.test(statement);
			let text = "";
			i++;
			while (i < source.length && source[i] !== quote) {
				if (source[i] === "\\") {
					text += source[i] ?? "";
					text += source[i + 1] ?? "";
					i += 2;
					continue;
				}
				if (source[i] === "\n") line++;
				text += source[i] ?? "";
				i++;
			}
			i++;
			if (!specifier) push(text, "string", startLine);
			previousSignificant = quote;
			continue;
		}
		if (ch === "/" && !["", ")", "]", "}", ..."abcdefghijklmnopqrstuvwxyz0123456789_$"].includes(previousSignificant)) {
			const startLine = line;
			let text = "";
			i++;
			let inClass = false;
			while (i < source.length && (source[i] !== "/" || inClass)) {
				const c = source[i] as string;
				if (c === "\\") {
					text += c + (source[i + 1] ?? "");
					i += 2;
					continue;
				}
				if (c === "[") inClass = true;
				else if (c === "]") inClass = false;
				text += c;
				i++;
			}
			i++;
			push(text, "regex", startLine);
			previousSignificant = "/";
			continue;
		}
		if (!/\s/.test(ch)) {
			previousSignificant = ch;
			if (ch === ";" || ch === "\n") statement = "";
			else statement += ch;
		}
		i++;
	}
	return out;
}

const LITERALS = extractLiterals(RULE_SOURCE);

describe("fast-path rule literals are repo-agnostic", () => {
	it("extracts the literals it is meant to guard (guard against a gutted test)", () => {
		assert.ok(LITERALS.length > 20, `expected the rule source to carry literals, got ${LITERALS.length}`);
		assert.ok(
			LITERALS.some((l) => l.kind === "regex" && l.text.includes("spawn")),
			"the spawn/execFile pattern must be among the extracted literals",
		);
		assert.ok(
			LITERALS.some((l) => l.kind === "string" && l.text === "similar-code-cross-family"),
			"rule ids must be among the extracted literals",
		);
	});

	it("contains no path separator in any literal", () => {
		for (const literal of LITERALS) {
			assert.ok(
				!literal.text.includes("/"),
				`line ${literal.line}: literal must be a pattern/lexicon token, not a path: ${literal.text}`,
			);
		}
	});

	it("contains no tracked path or basename of this or any analyzed checkout", () => {
		const { paths, basenames } = trackedPaths();
		for (const literal of LITERALS) {
			assert.ok(!paths.has(literal.text), `line ${literal.line}: literal is a repo path`);
			assert.ok(!basenames.has(literal.text), `line ${literal.line}: literal is a repo basename`);
			for (const path of paths) {
				assert.ok(
					!literal.text.includes(path),
					`line ${literal.line}: literal embeds the repo path ${path}`,
				);
			}
		}
	});

	it("contains no owner/repo, timestamp or snapshot id", () => {
		for (const literal of LITERALS) {			assert.ok(!literal.text.includes(OWNER_REPO), `line ${literal.line}: literal names the repository`);
			assert.ok(
				!ISO_TIMESTAMP.test(literal.text),
				`line ${literal.line}: literal carries an analysis timestamp`,
			);
			assert.ok(
				!SNAPSHOT_ID.test(literal.text),
				`line ${literal.line}: literal looks like a snapshot id: ${literal.text}`,
			);
		}
	});
});

// ─── The documented catalogue ─────────────────────────────────────

const TABLE_START = DOCS.indexOf("| # | Rule id |");
const TABLE_END = DOCS.indexOf("## Verified instances");
const TABLE = TABLE_START >= 0 && TABLE_END > TABLE_START ? DOCS.slice(TABLE_START, TABLE_END) : "";

/** The cells of one `| # | ... |` row, by row number. */
function tableRows(): Map<number, string[]> {
	const rows = new Map<number, string[]>();
	for (const line of TABLE.split("\n")) {
		if (!line.startsWith("| ")) continue;
		const cells = line
			.split("|")
			.map((c) => c.trim().replace(/^`|`$/g, ""))
			.filter((c) => c !== "");
		const row = Number(cells[0]);
		if (Number.isInteger(row)) rows.set(row, cells);
	}
	return rows;
}

describe("known-false-positives table stays mechanism-shaped", () => {
	it("has a parseable table between its header row and the Verified instances", () => {
		assert.ok(TABLE !== "", "the rule-id table region must exist");
		const rows = tableRows();
		assert.ok(rows.size >= 15, `expected at least 15 mechanism rows, got ${rows.size}`);
	});

	it("carries the mechanism lexicon instead of gutted rows", () => {
		for (const token of ["declare module", "shell: true", "TODO", "ast-grep", "wire()"]) {
			assert.ok(TABLE.includes(token), `the mechanism table must keep the lexicon token: ${token}`);
		}
	});

	it("contains no tracked path/basename, owner/repo, timestamp or snapshot id", () => {
		const { paths, basenames } = trackedPaths();
		const foreignBasenames = analyzedBasenames();
		const tokens = TABLE.split(/[^A-Za-z0-9_.$-]+/).filter((t) => t !== "");
		for (const token of tokens) {
			assert.ok(!paths.has(token), `the mechanism table names a repo path: ${token}`);
			assert.ok(
				!foreignBasenames.has(token),
				`the mechanism table names a basename of the analyzed repository: ${token}`,
			);
		}
		assert.ok(!TABLE.includes(OWNER_REPO), "the mechanism table must not name the analyzed repository");
		assert.ok(!ISO_TIMESTAMP.test(TABLE), "the mechanism table must not carry an analysis timestamp");
		assert.ok(!SNAPSHOT_ID.test(TABLE), "the mechanism table must not carry a snapshot id");
	});

	it("maps every fast-path row to its rule id, with a disproof step", () => {
		const rows = tableRows();
		for (const { ruleId, row } of FAST_PATH_RULES) {
			const cells = rows.get(row);
			assert.ok(cells, `row ${row} (${ruleId}) must stay in the table`);
			assert.strictEqual(cells[1], ruleId, `row ${row} must carry the rule id ${ruleId}`);
			assert.ok((cells[4] ?? "").length > 20, `row ${row} must keep its disproof step`);
			assert.ok(RULE_SOURCE.includes(ruleId), `rule id ${ruleId} must exist in lib/fast-path.ts`);
		}
	});

	it("covers the duplicate, similar-code and suggestion/zero-file families as generic rows", () => {
		const rows = tableRows();
		for (const row of [12, 13, 14, 15]) {
			const cells = rows.get(row) ?? [];
			const text = cells.join(" ");
			assert.match(text, /duplicate|similar|suggestion|derived/i, `row ${row} must state its family`);
			assert.ok(RULE_SOURCE.includes(cells[1] ?? ""), `row ${row} rule id must exist in lib/fast-path.ts`);
		}
	});

	it("keeps concrete instances out of the table and inside Verified instances", () => {
		const verified = DOCS.slice(TABLE_END);
		assert.ok(DOCS.includes("## Verified instances"), "the concrete instances need their own section");
		for (const instance of ["proper-lockfile-ambient.ts", "workspace-bae0a78d", "2026-10-08T19:34:31Z"]) {
			assert.ok(!TABLE.includes(instance), `the mechanism table must not name the instance ${instance}`);
			assert.ok(verified.includes(instance), `${instance} must live under Verified instances`);
		}
	});

	it("declares the rule catalogue the docs promise, with no duplicate id", () => {
		const ids = FAST_PATH_RULES.map((r) => r.ruleId);
		assert.strictEqual(new Set(ids).size, ids.length, "rule ids must be unique");
		for (const id of ids) {
			assert.match(id, /^[a-z][a-z0-9-]+$/, `rule id ${id} must be a stable kebab token`);
		}
	});
});
