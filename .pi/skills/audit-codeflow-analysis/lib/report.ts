/**
 * CodeFlow report — parsing and file-conflict grouping (pure).
 *
 * CodeFlow exports two browser-side formats. Both are captured by the shim's
 * browser bridge and parsed here:
 *
 *   - Markdown (`generateReport('md')`) — human-readable, carries security
 *     issues, unused functions, design/anti-patterns and architecture issues.
 *     The upstream exporter omits duplicates, layer violations and suggestions,
 *     so those categories are only available from the JSON export below.
 *   - JSON (`generateReport('json')`) — the authoritative structured report;
 *     `architectureIssues[].affectedFiles`, `duplicates[].files`,
 *     `layerViolations[]`, `suggestions[]`, `unusedFunctions[]`,
 *     `securityIssues[]` and `patterns[]` (design vs anti-pattern).
 *
 * Both parsers are defensive: the format is owned by the vendored UI and may
 * change, so unknown/absent sections yield no facts and truncated input never
 * throws. A fact is kept when it has at least one recoverable target — a file
 * path, a layer edge or a bare symbol — so the markdown format's path-less
 * architecture items survive instead of being dropped whole. Only file targets
 * drive file-isolation grouping; file-less facts are still surfaced.
 *
 * Formats verified against CodeFlow b0e82d1
 * (`test/fixtures/generate-report-fixtures.mjs` regenerates the fixtures from
 * the real generator).
 */

/**
 * A recoverable identity for a finding. The markdown exporter emits only
 * `x.name || x.file`, so an item may name a file, a `from → to` layer edge, or a
 * bare symbol (`execFn (3 files)`) — all three keep the finding alive; only the
 * `file` kind participates in file-isolation grouping.
 */
export type Target =
	| { kind: "file"; path: string }
	| { kind: "layer-edge"; from: string; to: string }
	| { kind: "symbol"; name: string };

export interface IssueFact {
	/** Stable id, unique within one parse (kind + per-kind index). */
	id: string;
	/** architecture | security | dead-code | duplicate | layer-violation | suggestion | pattern | anti-pattern */
	kind: string;
	title: string;
	/** Recoverable identities; a fact is kept when this is non-empty. */
	targets: Target[];
	/**
	 * File-only projection of `targets`, derived one-way so `groupIssues`,
	 * `selectCandidates` and file resolution keep operating on paths.
	 */
	files: string[];
}

export interface IssueGroup {
	id: string;
	issues: IssueFact[];
	/** True when the group holds a single issue touching a disjoint file set. */
	isolated: boolean;
	/** Paths claimed by two or more issues in this group (empty when isolated). */
	overlaps: string[];
}



/**
 * Pick the richest available source: the structured JSON report when it yields
 * facts, otherwise the markdown report. Keeps the skill from having to know
 * which artifact the browser produced.
 */
export function parseBestReport(markdown: string, json?: string | null): IssueFact[] {
	if (json) {
		const fromJson = parseReportJson(json);
		if (fromJson.length > 0) return fromJson;
	}
	return parseReport(markdown);
}

/**
 * Categories the markdown exporter never emits; the JSON export is their only
 * source. A run without a *usable* structured export cannot see them.
 */
export const JSON_ONLY_CATEGORIES = ["duplicate", "layer-violation", "suggestion"] as const;

/**
 * Single definition of a "usable structured export": a JSON body that yields at
 * least one fact. A body that classifies as JSON (an `architectureIssues` array)
 * can still be an empty stub — the shim's empty slot serves exactly that — and
 * must not count as a complete structured report. Shared by `fetch-report.ts`
 * (storage gate, `partial`) and `dry-run.mts` (source label) so the rule cannot
 * drift from `parseBestReport`.
 */
export function hasStructuredFindings(text: string | null | undefined): boolean {
	return parseReportJson(text ?? "").length > 0;
}

/**
 * Drop exact-duplicate facts. The exporter emits the same finding more than
 * once (two `on_open()` entries in one file, a security issue per matching
 * line), and validation runs per fact — so a duplicate is both a wasted
 * read-only subagent run and a duplicate candidate at the confirmation gate.
 * Preserves input order; keeps the first of each `(kind, title, targets)` group
 * (`files` being the file-only projection).
 */
export function dedupeIssues(issues: IssueFact[]): IssueFact[] {
	const seen = new Set<string>();
	const out: IssueFact[] = [];
	for (const issue of issues) {
		const identity = (issue.targets ?? fileTargets(issue.files)).map(targetKey);
		const key = `${issue.kind}\u0000${issue.title}\u0000${identity.join("\u0000")}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(issue);
	}
	return out;
}

export interface SectionCoverage {
	kind: string;
	/** The `## ` heading that declared this kind, as written by the exporter. */
	heading: string;
	/** `### ` items the exporter emitted under that heading. */
	items: number;
	/** Facts `parseReport` extracted for this kind. */
	candidates: number;
	/** `items` that yielded no parsed fact (`items - candidates`). */
	unparsedItems: number;
}

export interface UnparsedItem {
	/** The `## ` heading the item was declared under. */
	heading: string;
	/** The `### ` title the exporter emitted, with inline backticks stripped. */
	title: string;
}

/**
 * Name every `### ` item that yielded no target, in source order.
 * `reportSectionCoverage` counts these; this names them so a run can list what
 * the markdown format could not turn into a candidate.
 */
export function reportUnparsedItems(markdown: string): UnparsedItem[] {
	const md = markdown ?? "";
	const out: UnparsedItem[] = [];
	let kind: string | null = null;
	let heading = "";
	let title: string | null = null;
	let hasTarget = false;

	const flush = () => {
		if (title !== null && !hasTarget) out.push({ heading, title });
		title = null;
		hasTarget = false;
	};

	for (const raw of md.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const h2 = /^##\s+(.*)$/.exec(line);
		if (h2) {
			flush();
			heading = h2[1].trim();
			kind = sectionKind(heading);
			continue;
		}
		const h3 = /^###\s+(.*)$/.exec(line);
		if (h3) {
			flush();
			title = kind ? h3[1].replace(/`/g, "").trim() : null;
			continue;
		}
		if (title !== null && targetsFromRefLine(line).length > 0) hasTarget = true;
	}
	flush();
	return out;
}

/**
 * Reconcile the `###` items each markdown section declares against the
 * candidates `parseReport` extracts for that kind.
 *
 * A section that emits items but yields zero candidates means the parser is
 * dropping the entire section, not that the section is empty: the architecture
 * metrics arrive as `index.test.ts (46 fns)` and a token with whitespace is not
 * path-like, so every entry loses its file and `flush()` discards the fact.
 * Callers must treat `items > 0 && candidates === 0` as an unreadable section
 * and stop, never as "no findings here".
 */
export function reportSectionCoverage(markdown: string): SectionCoverage[] {
	const md = markdown ?? "";
	const byKind = new Map<string, { heading: string; items: number }>();
	let kind: string | null = null;

	for (const raw of md.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const h2 = /^##\s+(.*)$/.exec(line);
		if (h2) {
			const heading = h2[1].trim();
			kind = sectionKind(heading);
			if (kind && !byKind.has(kind)) byKind.set(kind, { heading, items: 0 });
			continue;
		}
		if (/^###\s+/.test(line) && kind) {
			const entry = byKind.get(kind);
			if (entry) entry.items++;
		}
	}

	const candidatesByKind = new Map<string, number>();
	for (const fact of parseReport(md)) {
		candidatesByKind.set(fact.kind, (candidatesByKind.get(fact.kind) ?? 0) + 1);
	}

	return [...byKind.entries()].map(([k, entry]) => {
		const candidates = candidatesByKind.get(k) ?? 0;
		return {
			kind: k,
			heading: entry.heading,
			items: entry.items,
			candidates,
			unparsedItems: Math.max(0, entry.items - candidates),
		};
	});
}

/**
 * Classify a fact as auto-suppressible noise or a candidate to validate.
 *
 * Only the *text-provable* shapes qualify: the LOW stylistic security
 * categories and cross-language layer violations. CodeFlow emits one `LOW: Code
 * Comments` / `LOW: Debug Statements` per matching line and both are known to
 * fire on string literals in fixtures, ast-grep patterns and JSON (see
 * `references/known-false-positives.md`). Every code-read shape — secrets, SQL
 * injection, shell execution, command execution, dead code — stays `keep`: its
 * mechanism can only be disproved by reading the code, so it goes to the
 * validator, never to a text filter. Suppression depends on the fact alone, never
 * the filesystem.
 */

/**
 * Language family of a path by extension, or null when the extension is
 * unrecognised. `.ts`/`.mts`/`.tsx`/`.js`/`.mjs`/`.jsx` share one family: a
 * TypeScript module can import a JavaScript one (and vice versa), so that pair
 * is not a language boundary.
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

function languageFamily(path: string): string | null {
	const m = /\.([A-Za-z0-9]+)\s*$/.exec(path.trim());
	return m ? (LANGUAGE_BY_EXTENSION[m[1].toLowerCase()] ?? null) : null;
}

/** A layer edge whose two files cannot be imports of one another (no shared family). */
function isCrossLanguageLayerViolation(files: string[]): boolean {
	if (files.length < 2) return false;
	const families = files.map(languageFamily);
	// An unknown extension is kept: fail safe, never hide a finding on a guess.
	if (families.some((f) => f === null)) return false;
	return new Set(families).size > 1;
}

export function classifyKnownNoise(fact: IssueFact): "suppress" | "keep" {
	if (fact.kind === "layer-violation") {
		// CodeFlow layer violations are import-based, so a `.ts` → `.rs` edge cannot
		// be an import: it is a bare-identifier match across a language boundary.
		return isCrossLanguageLayerViolation(fact.files) ? "suppress" : "keep";
	}
	if (fact.kind !== "security") return "keep";
	const title = fact.title.replace(/\s+/g, " ").trim().toLowerCase();
	return /^low:\s*(code comments|debug statements)$/.test(title) ? "suppress" : "keep";
}

/** Issue type the triage policy assigns to a fact. */
export type IssueType = "bug" | "chore" | "informational" | "out-of-scope";

/** What Step 5/6 should do with a fact. */
export type Disposition = "file-bug" | "file-refactor" | "offer-optional" | "drop";

/** The derived architecture metrics the exporter emits as `<N> Metric` titles. */
const METRIC_TITLE = /^\d+\s+(large files|highly coupled|high complexity files)\b/i;

/**
 * Triage policy: decide an issue type *and* its disposition *before* any validator
 * reads code, so scope is never a validator's call. `pattern` is informational and
 * offered as an optional filing; `anti-pattern` and the derived
 * size/coupling/complexity metrics are refactor scope and filed by default (with a
 * Step 6 opt-out); every other known kind is bug-template scope. Pure and
 * deterministic.
 */
export function classifyFinding(fact: IssueFact): {
	issueType: IssueType;
	disposition: Disposition;
	reason: string;
} {
	if (fact.kind === "pattern") {
		return {
			issueType: "informational",
			disposition: "offer-optional",
			reason: "design pattern present — informational; offered as an optional filing",
		};
	}
	if (fact.kind === "anti-pattern") {
		return {
			issueType: "chore",
			disposition: "file-refactor",
			reason: "anti-pattern — refactor scope, never the bug template",
		};
	}
	if (METRIC_TITLE.test(fact.title)) {
		return {
			issueType: "chore",
			disposition: "file-refactor",
			reason: "size/coupling/complexity metric — refactor scope",
		};
	}
	if (
		["architecture", "security", "dead-code", "duplicate", "layer-violation", "suggestion"].includes(
			fact.kind,
		)
	) {
		return { issueType: "bug", disposition: "file-bug", reason: "bug-template kind" };
	}
	return {
		issueType: "out-of-scope",
		disposition: "drop",
		reason: `unknown kind ${JSON.stringify(fact.kind)}`,
	};
}

/**
 * Group issues so each group's issues can be reasoned about as one unit:
 * issues that share any file are merged (transitively) into a single group.
 * Deterministic (input order), and every input issue lands in exactly one group.
 */
export function groupIssues(issues: IssueFact[]): IssueGroup[] {
	const fileToIssues = new Map<string, number[]>();
	issues.forEach((iss, idx) => {
		for (const f of iss.files) {
			const list = fileToIssues.get(f);
			if (list) list.push(idx);
			else fileToIssues.set(f, [idx]);
		}
	});

	const seen = new Array<boolean>(issues.length).fill(false);
	const groups: IssueGroup[] = [];
	for (let i = 0; i < issues.length; i++) {
		if (seen[i]) continue;
		const members: number[] = [];
		const queue = [i];
		seen[i] = true;
		while (queue.length > 0) {
			const cur = queue.shift() as number;
			members.push(cur);
			for (const f of issues[cur].files) {
				for (const j of fileToIssues.get(f) ?? []) {
					if (!seen[j]) {
						seen[j] = true;
						queue.push(j);
					}
				}
			}
		}
		members.sort((a, b) => a - b);
		const counts = new Map<string, number>();
		for (const m of members) {
			for (const f of issues[m].files) counts.set(f, (counts.get(f) ?? 0) + 1);
		}
		const overlaps = [...counts.entries()]
			.filter(([, c]) => c > 1)
			.map(([f]) => f)
			.sort();
		const memberIssues = members.map((m) => issues[m]);
		groups.push({
			id: `group:${memberIssues[0].id}`,
			issues: memberIssues,
			isolated: memberIssues.length === 1,
			overlaps,
		});
	}
	return groups;
}

// ─── Split-out parser modules (issue #2001) ──────────────────────
// The markdown/JSON adapters live in report-markdown.ts / report-json.ts;
// re-exported here so importers keep this path (SKILL.md pins report.ts as
// the single policy source).
import {
	fileTargets,
	parseReport,
	sectionKind,
	targetKey,
	targetsFromRefLine,
} from "./report-markdown.ts";
import { parseReportJson } from "./report-json.ts";

export { parseReport } from "./report-markdown.ts";
export { parseReportJson } from "./report-json.ts";
