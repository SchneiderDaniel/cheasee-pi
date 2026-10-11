#!/usr/bin/env node
/**
 * Dry run of the codeflow-analysis skill.
 *
 * Extracts findings from the CodeFlow report and PRINTS the issues the skill
 * would file. Nothing is created and no subagent is spawned: this script never
 * calls `gh`.
 *
 * Usage:
 *   node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts
 *   ... --limit 5 --report ignore/codeflow-report.md --json ignore/codeflow-report.json
 *   ... --list | --emit-findings [DIR] | --self-check
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	classifyFinding,
	dedupeIssues,
	hasStructuredFindings,
	parseBestReport,
	reportSectionCoverage,
	reportUnparsedItems,
	type Disposition,
	type IssueFact,
	type IssueType,
	type SectionCoverage,
	type Target,
} from "../lib/report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ─── Pure helpers (covered by --self-check) ───────────────────────

function draftIssue(
	fact: IssueFact,
	sourceLabel: string,
	issueType: IssueType,
): { title: string; body: string } {
	const cited = describeTargets(fact);
	return {
		title: `[${issueType}] CodeFlow ${fact.kind}: ${fact.title}`,
		body: [
			"## Describe the bug",
			`CodeFlow reports **${fact.title}** (kind: \`${fact.kind}\`, issue type: \`${issueType}\`) in ${cited}.`,
			"",
			"## Expected behavior",
			"The finding no longer applies once the cited code is addressed.",
			"",
			"## Additional context",
			`- Source: CodeFlow ${sourceLabel} finding \`${fact.id}\``,
			`- Targets: ${cited}`,
			"- This finding may be a false positive, but it still indicates badly designed code that should be improved. Confirm the claim against the cited code before fixing.",
		].join("\n"),
	};
}

/** Render one target for a human: paths and symbols backticked, edges as `A → B`. */
function renderTarget(target: Target): string {
	if (target.kind === "file") return `\`${target.path}\``;
	if (target.kind === "layer-edge") return `${target.from} → ${target.to}`;
	return `\`${target.name}\``;
}

/** Human-readable target list; a fact with no target is a derived signal. */
function describeTargets(fact: IssueFact): string {
	const targets: Target[] =
		fact.targets ?? fact.files.map((path) => ({ kind: "file" as const, path }));
	if (targets.length === 0) return "(no file — derived signal)";
	return targets.map(renderTarget).join(", ");
}

/**
 * The markdown exporter prints a fixed sample of a metric's files, never all N.
 * Disclose the gap (`5 of 75`) so a filed body never implies it lists them all.
 */
function sampleNote(fact: IssueFact): string | null {
	const m = /^(\d+)\s+/.exec(fact.title);
	if (!m) return null;
	const total = Number(m[1]);
	const listed = fact.files.length;
	if (listed === 0 || total <= listed) return null;
	return `**Sample:** ${listed} of ${total} affected file(s) listed — the markdown export carries only a sample.`;
}

function renderResolved(file: string, r: FileResolution): string {
	if (r.how === "exact") return r.path;
	if (r.how === "basename") return `${r.path} (basename of \`${file}\`)`;
	return `${file} (unresolved)`;
}

/** basename → repo path, preferring the shortest (deterministic) match. */
function indexBasenames(paths: string[]): Map<string, string> {
	const index = new Map<string, string>();
	for (const path of paths) {
		const base = path.split("/").pop() ?? path;
		const seen = index.get(base);
		if (
			seen === undefined ||
			path.length < seen.length ||
			(path.length === seen.length && path < seen)
		) {
			index.set(base, path);
		}
	}
	return index;
}

export type FileResolution = { path: string; how: "exact" | "basename" | "unresolved" };

/**
 * Resolve a report-cited path. CodeFlow's markdown exporter emits bare
 * basenames in its pattern/anti-pattern sections, so an exact miss is retried
 * against the repo index before the file is called missing.
 */
function resolveCited(
	exists: (path: string) => boolean,
	index: Map<string, string>,
	file: string,
): FileResolution {
	if (exists(file)) return { path: file, how: "exact" };
	const hit = index.get(file.split("/").pop() ?? file);
	if (hit) return { path: hit, how: "basename" };
	return { path: file, how: "unresolved" };
}

/** Candidate file naming slug: lowercase, non-alphanumerics to single hyphens. */
export function slugifyFinding(title: string): string {
	const slug =
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "finding";
	// Bound the filename: a full title can exceed the 255-byte filesystem limit
	// (`ENAMETOOLONG`). Truncate and append a hash of the full title so two long
	// titles sharing a prefix stay distinct and determinism is preserved.
	if (Buffer.byteLength(slug, "utf-8") <= 80) return slug;
	const hash = createHash("sha256").update(title).digest("hex").slice(0, 8);
	return `${slug.slice(0, 80).replace(/-+$/, "")}-${hash}`;
}

/** Candidate body: kind, triage issue type/disposition, targets, id and the cited files. */
function findingFileContent(fact: IssueFact): string {
	const { issueType, disposition, reason } = classifyFinding(fact);
	const sample = sampleNote(fact);
	return (
		[
			`# CodeFlow finding (${fact.kind})`,
			"",
			`**Kind:** ${fact.kind}`,
			`**Issue type:** ${issueType}`,
			`**Disposition:** ${disposition}`,
			`**Title:** ${fact.title}`,
			`**Id:** ${fact.id}`,
			`**Section:** ${fact.kind}`,
			`**Targets:** ${describeTargets(fact)}`,
			`**Files:** ${fact.files.length > 0 ? fact.files.join(", ") : "(none)"}`,
			...(sample ? [sample] : []),
			"",
			`Triage: ${issueType} (${disposition}) — ${reason}.`,
			"The markdown/inspection export carries no description; read the cited code before",
			"filing the issue.",
		].join("\n") + "\n"
	);
}

/**
 * One line naming each nonzero disposition (file-bug, file-refactor,
 * offer-optional, drop) with its count, so whatever triage routed is visible.
 */
function dispositionSummary(facts: IssueFact[]): string {
	const order: Disposition[] = ["file-bug", "file-refactor", "offer-optional", "drop"];
	const counts = new Map<Disposition, number>();
	for (const fact of facts) {
		const d = classifyFinding(fact).disposition;
		counts.set(d, (counts.get(d) ?? 0) + 1);
	}
	return (
		order
			.filter((d) => (counts.get(d) ?? 0) > 0)
			.map((d) => `${d} ${counts.get(d)}`)
			.join(", ") || "none"
	);
}

/**
 * Write one `NN-<slug>.md` candidate per fact; returns the written paths.
 *
 * Fails closed when the destination already holds findings: a rerun that mixed
 * a fresh candidate set with a prior run's files would present stale candidates
 * as current. The operator must point at a fresh directory (or remove the stale
 * files) instead.
 */
function writeFindingFiles(dir: string, facts: IssueFact[]): string[] {
	const stale = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
	if (stale.length > 0) {
		throw new Error(
			`refusing to write findings into ${dir}: it already contains ${stale.length} stale file(s) ` +
				`(${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", …" : ""}). ` +
				`Use a fresh destination directory or remove the stale files first, so the candidate set is never mixed.`,
		);
	}
	mkdirSync(dir, { recursive: true });
	return facts.map((fact, i) => {
		const file = join(dir, `${String(i + 1).padStart(2, "0")}-${slugifyFinding(fact.title)}.md`);
		writeFileSync(file, findingFileContent(fact), "utf-8");
		return file;
	});
}

// ─── CLI ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
	limit: number;
	report: string;
	json: string | null;
	selfCheck: boolean;
	listOnly: boolean;
	emitFindings: boolean;
	emitDir: string | null;
} {
	const out = {
		limit: 5,
		report: "ignore/codeflow-report.md",
		json: null as string | null,
		selfCheck: false,
		listOnly: false,
		emitFindings: false,
		emitDir: null as string | null,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--self-check") out.selfCheck = true;
		else if (arg === "--list") out.listOnly = true;
		else if (arg === "--emit-findings") {
			out.emitFindings = true;
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				out.emitDir = next;
				i++;
			}
		} else if (arg === "--limit") out.limit = Number(argv[++i]);
		else if (arg === "--report") out.report = argv[++i];
		else if (arg === "--json") out.json = argv[++i];
		else if (arg === "--help" || arg === "-h") {
			process.stdout.write(
				"usage: dry-run.mts [--limit N] [--report FILE] [--json FILE] [--list] [--emit-findings [DIR]] [--self-check]\n" +
					"  --list           extract findings and resolve cited files only (no issue drafts)\n" +
					"  --emit-findings  write every candidate to NN-<slug>.md (no deletion)\n",
			);
			process.exit(0);
		} else {
			process.stderr.write(`unknown argument: ${arg}\n`);
			process.exit(2);
		}
	}
	if (!Number.isInteger(out.limit) || out.limit < 1) {
		process.stderr.write(`--limit must be a positive integer, got ${out.limit}\n`);
		process.exit(2);
	}
	return out;
}

function selfCheck(): number {
	const checks: Array<[string, boolean]> = [
		[
			"draft carries files",
			draftIssue(
				{
					id: "security:0",
					kind: "security",
					title: "HIGH: X",
					targets: [{ kind: "file", path: "a/b.ts" }],
					files: ["a/b.ts"],
				},
				"markdown",
				"bug",
			).body.includes("`a/b.ts`"),
		],
		[
			"draft handles file-less fact",
			draftIssue(
				{
					id: "suggestion:0",
					kind: "suggestion",
					title: "Split module",
					targets: [],
					files: [],
				},
				"markdown",
				"bug",
			).body.includes("(no file"),
		],
		[
			"draft renders a layer edge",
			draftIssue(
				{
					id: "architecture:0",
					kind: "architecture",
					title: "157 Architecture Violations",
					targets: [{ kind: "layer-edge", from: "utils", to: "ui" }],
					files: [],
				},
				"markdown",
				"bug",
			).body.includes("utils → ui"),
		],
		[
			"basename resolution",
			resolveCited(() => false, indexBasenames(["a/b/c.go", "a/c.go"]), "c.go").path === "a/c.go",
		],
		[
			"exact path wins",
			resolveCited((p) => p === "x/y.go", indexBasenames(["x/y.go"]), "x/y.go").how === "exact",
		],
		[
			"unknown path flagged",
			resolveCited(() => false, indexBasenames(["a/b.go"]), "ghost.md").how === "unresolved",
		],
		[
			"stub JSON is not a structured export",
			hasStructuredFindings('{"architectureIssues":[]}') === false,
		],
		[
			"usable JSON is a structured export",
			hasStructuredFindings('{"architectureIssues":[{"title":"x"}]}') === true,
		],
		[
			"draft carries the false-positive note",
			draftIssue(
				{
					id: "security:0",
					kind: "security",
					title: "HIGH: X",
					targets: [{ kind: "file", path: "a/b.ts" }],
					files: ["a/b.ts"],
				},
				"markdown",
				"bug",
			).body.includes("may be a false positive"),
		],
		[
			"metric disposition is file-refactor",
			classifyFinding({
				id: "architecture:0",
				kind: "architecture",
				title: "81 Large Files",
				targets: [],
				files: [],
			}).disposition === "file-refactor",
		],
		[
			"pattern disposition is offer-optional",
			classifyFinding({
				id: "pattern:0",
				kind: "pattern",
				title: "Singleton",
				targets: [],
				files: [],
			}).disposition === "offer-optional",
		],
	];
	let failed = 0;
	for (const [name, ok] of checks) {
		if (!ok) {
			failed++;
			process.stderr.write(`FAIL: ${name}\n`);
		}
	}
	process.stdout.write(
		failed === 0 ? `self-check OK (${checks.length} checks)\n` : `${failed} self-check(s) failed\n`,
	);
	return failed === 0 ? 0 : 1;
}

/** Disclosure printed whenever the structured JSON export is unavailable. */
function jsonNote(): string {
	return (
		"JSON export unavailable — duplicate, layer-violation and suggestion categories\n" +
		"cannot be extracted from markdown; those categories are partially unauditable from this report.\n"
	);
}

/**
 * Coverage table plus the `###` titles the markdown format could not turn into
 * candidates. Every mode prints it (not just `--list`), so a partial parse is
 * always disclosed as a partial audit and never mistaken for a clean run. A
 * section with `candidates === 0` is flagged `UNREADABLE`.
 */
function coverageReport(markdown: string, coverage: SectionCoverage[]): string {
	const lines = ["section coverage (### items the exporter emitted vs candidates parsed):"];
	for (const c of coverage) {
		const flag = c.items > 0 && c.candidates === 0 ? "  <-- UNREADABLE" : "";
		lines.push(
			`  ${c.heading}: ${c.items} item(s), ${c.candidates} candidate(s), ${c.unparsedItems} unparsed${flag}`,
		);
	}
	const unparsed = reportUnparsedItems(markdown);
	if (unparsed.length > 0) {
		lines.push(
			"",
			"items the exporter declared but the markdown format cannot turn into candidates:",
		);
		for (const u of unparsed) lines.push(`  ${u.heading}: ${u.title}`);
	}
	return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.selfCheck) process.exit(selfCheck());

	const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: HERE,
		encoding: "utf-8",
	}).trim();
	const reportPath = resolve(repoRoot, args.report);
	if (!existsSync(reportPath)) {
		process.stderr.write(
			`report not found: ${reportPath}\nRun an analysis in the CodeFlow UI first.\n`,
		);
		process.exit(2);
	}
	const jsonPath = args.json
		? resolve(repoRoot, args.json)
		: join(repoRoot, "ignore/codeflow-report.json");
	const jsonContent = existsSync(jsonPath) ? readFileSync(jsonPath, "utf-8") : null;
	// The single usability predicate: a format-valid but facts-less stub is not a
	// structured export, so the run must fall back to markdown and disclose it.
	const json = hasStructuredFindings(jsonContent) ? jsonContent : null;
	const markdown = readFileSync(reportPath, "utf-8");

	const facts = parseBestReport(markdown, json);
	if (facts.length === 0) {
		process.stderr.write(`no findings parsed from ${reportPath}\n`);
		process.exit(2);
	}

	// Guardrail: a section that emitted `###` items but parsed to zero candidates
	// means the parser is dropping it whole, not that the section is empty. The
	// markdown export is the only source with sections to count.
	const coverage = reportSectionCoverage(markdown);
	const uncovered = coverage.filter((c) => c.items > 0 && c.candidates === 0);
	if (uncovered.length > 0) {
		process.stdout.write(
			`WARNING: ${uncovered.length} section(s) emitted items but yielded no candidates — ` +
				`the parser is dropping them:\n` +
				uncovered.map((c) => `  ${c.heading}: ${c.items} item(s), 0 candidates\n`).join("") +
				`Fix the extraction before trusting this candidate set.\n\n`,
		);
	}

	const unique = dedupeIssues(facts);

	const basenameIndex = indexBasenames(
		execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf-8" })
			.split("\n")
			.filter((l) => l !== ""),
	);
	const resolveFile = (file: string): FileResolution =>
		resolveCited((p) => existsSync(resolve(repoRoot, p)), basenameIndex, file);

	// Every deduped finding is a candidate. Scope is decided once, here, by
	// `classifyFinding` (the single policy source): metrics and informational
	// facts are routed to refactor/optional issues, the rest are bug-class.
	const candidates = unique;
	const issueTypeOf = (fact: IssueFact): IssueType => classifyFinding(fact).issueType;
	const routed = candidates.filter((f) => issueTypeOf(f) !== "bug");

	if (args.emitFindings) {
		// Extraction only: write the candidate set and exit. No subagent is
		// spawned, --limit does not truncate, and the directory is never removed.
		const dir = resolve(repoRoot, args.emitDir ?? "ignore/codeflow-findings");
		const files = writeFindingFiles(dir, candidates);
		process.stdout.write(
			`CodeFlow findings emitted — ${files.length} candidate(s) written to ${dir.replace(`${repoRoot}/`, "")}\n` +
				`${routed.length} finding(s) routed by triage to refactor/optional issues.\n` +
				`dispositions: ${dispositionSummary(candidates)}\n` +
				`\n${coverageReport(markdown, coverage)}` +
				(!json ? `\n${jsonNote()}` : "") +
				`\nNo issues created.\n`,
		);
		process.exit(0);
	}

	if (args.listOnly) {
		const cited = candidates.flatMap((f) => f.files).map(resolveFile);
		for (const [i, fact] of candidates.entries()) {
			const files =
				fact.files.length > 0
					? fact.files.map((f) => renderResolved(f, resolveFile(f))).join(", ")
					: "(none)";
			process.stdout.write(
				`[${i + 1}] ${fact.kind} — ${fact.title} [${issueTypeOf(fact)}]\n` +
					`      targets: ${describeTargets(fact)}\n      files: ${files}\n`,
			);
		}
		const unresolved = cited.filter((r) => r.how === "unresolved");
		process.stdout.write(`\n${coverageReport(markdown, coverage)}`);
		if (!json) process.stdout.write(`\n${jsonNote()}`);
		process.stdout.write(
			`\n${candidates.length} finding(s), ${routed.length} routed by triage to refactor/optional issues, ` +
				`${cited.length} cited file(s), ${cited.length - unresolved.length} found, ` +
				`${unresolved.length} unresolved.\n` +
				`dispositions: ${dispositionSummary(candidates)}\n` +
				`No issues created.\n`,
		);
		process.exit(0);
	}

	const selected = candidates.slice(0, args.limit);

	const sourceLabel = json ? "json" : "markdown";
	process.stdout.write(
		`CodeFlow dry run — ${reportPath.replace(`${repoRoot}/`, "")} (${sourceLabel}, ` +
			`${facts.length} finding(s), ${unique.length} unique, ${facts.length - unique.length} duplicate(s) dropped)\n` +
			`${routed.length} finding(s) routed by triage:\n` +
			routed.map((f) => `  [${issueTypeOf(f)}] ${f.title}\n`).join("") +
			`dispositions: ${dispositionSummary(candidates)}\n` +
			`\n${coverageReport(markdown, coverage)}\n` +
			(!json ? jsonNote() : "") +
			`Would file ${candidates.length} issue(s); printing the first ${selected.length}. No issues are created.\n\n`,
	);

	selected.forEach((fact, i) => {
		const files =
			fact.files.length > 0
				? fact.files.map((f) => renderResolved(f, resolveFile(f))).join(", ")
				: "(none)";
		const draft = draftIssue(fact, sourceLabel, issueTypeOf(fact));
		process.stdout.write(
			`[${i + 1}/${selected.length}] ${fact.kind} — ${fact.title}\n      files: ${files}\n`,
		);
		process.stdout.write(`      Title: ${draft.title}\n`);
		for (const line of draft.body.split("\n")) process.stdout.write(`      │ ${line}\n`);
		process.stdout.write("\n");
	});

	const cited = candidates.flatMap((f) => f.files).map(resolveFile);
	const byBasename = cited.filter((r) => r.how === "basename").length;
	const unresolved = cited.filter((r) => r.how === "unresolved");
	process.stdout.write(
		`Summary: ${candidates.length} candidate(s) — would file ${candidates.length} issue(s), ` +
			`${routed.length} routed by triage.\n` +
			`Codebase link: ${cited.length - unresolved.length}/${cited.length} cited file(s) found` +
			`${byBasename > 0 ? ` (${byBasename} by basename)` : ""}` +
			`${unresolved.length > 0 ? `; unresolved: ${unresolved.map((r) => r.path).join(", ")}` : ""}.\n` +
			`No issues created (dry run).\n`,
	);
	process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err: unknown) => {
		process.stderr.write(`dry run failed: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(2);
	});
}
