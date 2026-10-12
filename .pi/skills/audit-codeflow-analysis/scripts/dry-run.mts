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
 *   ... --list | --emit-findings [DIR] | --emit-issues [DIR] | --self-check
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	classifyFinding,
	dedupeIssues,
	groupIssues,
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

// ─── Issue drafting (--emit-issues) ───────────────────────────────

/** One proposed issue: the facts it covers and the issue scope triage assigns. */
export interface DraftGroup {
	/** Stable identity (kind+title for subject mode, group id for graph mode). */
	key: string;
	/** Highest triage issue type across the group's facts (bug > chore > informational). */
	issueType: IssueType;
	dispositions: Disposition[];
	/** Display title: the single subject, or the first plus a `(+N more)` suffix. */
	title: string;
	facts: IssueFact[];
	files: string[];
}

/** A group's issue type is the strongest member's, so a mixed graph group is a bug. */
function highestIssueType(types: IssueType[]): IssueType {
	for (const t of ["bug", "chore", "informational"] as const) {
		if (types.includes(t)) return t;
	}
	return "out-of-scope";
}

function buildGroup(key: string, groupFacts: IssueFact[]): DraftGroup {
	const titles = [...new Set(groupFacts.map((f) => f.title))];
	return {
		key,
		issueType: highestIssueType(groupFacts.map((f) => classifyFinding(f).issueType)),
		dispositions: [...new Set(groupFacts.map((f) => classifyFinding(f).disposition))],
		title: titles.length === 1 ? titles[0] : `${titles[0]} (+${titles.length - 1} more)`,
		facts: groupFacts,
		files: [...new Set(groupFacts.flatMap((f) => f.files))].sort(),
	};
}

/**
 * One proposed issue per canonical `(kind, title)` subject. This is the default
 * because file-graph merging collapses every metric that touches hundreds of
 * files into a single unworkable group; subject grouping keeps one issue on one
 * subject and discloses the remaining file overlap instead.
 */
export function groupFactsBySubject(facts: IssueFact[]): DraftGroup[] {
	const byKey = new Map<string, IssueFact[]>();
	const order: string[] = [];
	for (const fact of facts) {
		const key = `${fact.kind}\u0000${fact.title}`;
		const list = byKey.get(key);
		if (list) list.push(fact);
		else {
			byKey.set(key, [fact]);
			order.push(key);
		}
	}
	return order.map((key) => buildGroup(key, byKey.get(key) as IssueFact[]));
}

/** One proposed issue per file-conflict group (transitive merge on shared files). */
export function groupFactsByFileGraph(facts: IssueFact[]): DraftGroup[] {
	return groupIssues(facts).map((g) => buildGroup(g.id, g.issues));
}

export interface DraftContext {
	analyzedAt: string | null;
	allGroups: DraftGroup[];
}

/** The analysis timestamp: the structured `analyzedAt` wins over the markdown line. */
export function readAnalyzedAt(jsonText: string | null, markdown: string): string | null {
	if (jsonText) {
		try {
			const root = JSON.parse(jsonText) as Record<string, unknown>;
			const v = root.analyzedAt;
			if (typeof v === "string" && v.trim() !== "") return v.trim();
			if (typeof v === "number") return String(v);
		} catch {
			// fall through to the markdown line
		}
	}
	const m = /^\*\*Analyzed:\*\*\s*(.+)$/m.exec(markdown ?? "");
	return m ? m[1].trim() : null;
}

/**
 * Draft one issue from a group: template-appropriate title/body, the cited
 * CodeFlow signal, the affected files, the best-effort isolation note (shared
 * files listed), the analysis timestamp and the false-positive note.
 */
export function draftIssueForGroup(
	group: DraftGroup,
	ctx: DraftContext,
): { title: string; body: string } {
	const label =
		group.issueType === "bug" ? "[Bug]" : group.issueType === "chore" ? "[Refactor]" : "[Info]";
	const title = `${label} ${group.title}`;
	const descriptions = [
		...new Set(group.facts.map((f) => f.description).filter((d): d is string => !!d)),
	];
	const shared = group.files.filter((f) =>
		ctx.allGroups.some((o) => o.key !== group.key && o.files.includes(f)),
	);
	const signal = [
		`**Kinds:** ${[...new Set(group.facts.map((f) => f.kind))].join(", ")}`,
		`**Titles:** ${[...new Set(group.facts.map((f) => f.title))].map((t) => `\`${t}\``).join(", ")}`,
		`**Dispositions:** ${group.dispositions.join(", ")}`,
		...(descriptions.length > 0 ? [`**Description:** ${descriptions.join(" /")}`] : []),
		...(ctx.analyzedAt !== null ? [`**analyzedAt:** \`${ctx.analyzedAt}\``] : []),
	].join("\n");
	const isolation =
		group.files.length === 0
			? "File-less finding (derived signal); file isolation is not applicable."
			: shared.length === 0
				? "Isolated: no other drafted issue shares a file with this one."
				: `Best-effort isolation only: ${shared.length} of ${group.files.length} file(s) are shared with other drafted issues.`;
	const body = [
		"## Describe the bug",
		`CodeFlow reports **${group.title}** (${group.issueType})${descriptions.length > 0 ? `: ${descriptions.join(" /")}` : "."}`,
		"",
		"## Expected behavior",
		"The CodeFlow signal no longer applies once the cited code is addressed.",
		"",
		"## Additional context",
		"",
		"### CodeFlow signal",
		"",
		signal,
		"",
		`### Affected files (${group.files.length})`,
		"",
		group.files.length > 0 ? group.files.map((f) => `- \`${f}\``).join("\n") : "(none)",
		"",
		"### Best-effort isolation",
		"",
		isolation,
		...(shared.length > 0 ? ["", "Shared files:", ...shared.map((f) => `- \`${f}\``)] : []),
		"",
		"### False positive",
		"This finding may be a false positive, but it still indicates badly designed code that should be improved. Confirm the claim against the cited code before fixing.",
		"",
	].join("\n");
	return { title, body };
}

/**
 * Write one `<NN>-<slug>.md` body plus `<NN>-<slug>.title`, and a `MANIFEST.txt`.
 * Fails closed when the destination already holds drafts, so a rerun cannot mix
 * a fresh proposed set with a prior one.
 */
function writeIssueFiles(dir: string, groups: DraftGroup[], ctx: DraftContext): string[] {
	const stale = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
	if (stale.length > 0) {
		throw new Error(
			`refusing to write drafts into ${dir}: it already contains ${stale.length} stale file(s) ` +
				`(${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", …" : ""}). ` +
				"Use a fresh destination directory or remove the stale files first, so the proposed set is never mixed.",
		);
	}
	mkdirSync(dir, { recursive: true });
	const manifest: string[] = [];
	groups.forEach((group, i) => {
		const base = `${String(i + 1).padStart(2, "0")}-${slugifyFinding(group.title)}`;
		const draft = draftIssueForGroup(group, ctx);
		writeFileSync(join(dir, `${base}.md`), draft.body, "utf-8");
		writeFileSync(join(dir, `${base}.title`), draft.title, "utf-8");
		manifest.push(
			`${base}\t${draft.title}\t${group.issueType}\t${group.dispositions.join("+")}\tfiles=${group.files.length}\tfacts=${group.facts.length}`,
		);
	});
	writeFileSync(join(dir, "MANIFEST.txt"), manifest.join("\n") + "\n", "utf-8");
	return groups.map((g, i) => `${String(i + 1).padStart(2, "0")}-${slugifyFinding(g.title)}.md`);
}

/** The proposed-set table printed before the confirmation gate. */
function issueTable(groups: DraftGroup[]): string {
	return groups
		.map((g, i) => {
			const shared = g.files.filter((f) =>
				groups.some((o) => o.key !== g.key && o.files.includes(f)),
			).length;
			return (
				`  ${String(i + 1).padStart(2, "0")} [${g.issueType}] ${g.title}\n` +
				`        files=${g.files.length} shared=${shared} facts=${g.facts.length} dispositions=${g.dispositions.join(",")}`
			);
		})
		.join("\n");
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
	emitIssues: boolean;
	emitIssuesDir: string | null;
	by: "subject" | "group";
	analyzedAt: string | null;
} {
	const out = {
		limit: 5,
		report: "ignore/codeflow-report.md",
		json: null as string | null,
		selfCheck: false,
		listOnly: false,
		emitFindings: false,
		emitDir: null as string | null,
		emitIssues: false,
		emitIssuesDir: null as string | null,
		by: "subject" as "subject" | "group",
		analyzedAt: null as string | null,
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
		} else if (arg === "--emit-issues") {
			out.emitIssues = true;
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				out.emitIssuesDir = next;
				i++;
			}
		} else if (arg === "--by") {
			const value = argv[++i];
			if (value !== "subject" && value !== "group") {
				process.stderr.write(`--by must be subject or group, got ${value}\n`);
				process.exit(2);
			}
			out.by = value;
		} else if (arg === "--analyzed-at") out.analyzedAt = argv[++i];
		else if (arg === "--limit") out.limit = Number(argv[++i]);
		else if (arg === "--report") out.report = argv[++i];
		else if (arg === "--json") out.json = argv[++i];
		else if (arg === "--help" || arg === "-h") {
			process.stdout.write(
				"usage: dry-run.mts [--limit N] [--report FILE] [--json FILE] [--list] [--emit-findings [DIR]] [--emit-issues [DIR]] [--by subject|group] [--analyzed-at VALUE] [--self-check]\n" +
					"  --list           extract findings and resolve cited files only (no issue drafts)\n" +
					"  --emit-findings  write every candidate to NN-<slug>.md (no deletion)\n" +
					"  --emit-issues    write one proposed issue body+title per group (no deletion, no gh)\n" +
					"  --by             issue grouping: subject (kind+title, default) or group (shared files)\n",
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
	const mk = (id: string, kind: string, title: string, files: string[]): IssueFact => ({
		id,
		kind,
		title,
		targets: files.map((path) => ({ kind: "file", path })),
		files,
	});
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
		[
			"subject grouping merges same kind+title",
			groupFactsBySubject([
				mk("a", "security", "HIGH: X", ["a.ts"]),
				mk("b", "security", "HIGH: X", ["b.ts"]),
			]).length === 1,
		],
		[
			"subject grouping keeps distinct titles apart",
			groupFactsBySubject([
				mk("a", "security", "HIGH: X", ["a.ts"]),
				mk("b", "security", "HIGH: Y", ["a.ts"]),
			]).length === 2,
		],
		[
			"file-graph grouping merges shared files",
			groupFactsByFileGraph([
				mk("a", "security", "A", ["shared.ts"]),
				mk("b", "dead-code", "B()", ["shared.ts"]),
			]).length === 1,
		],
		[
			"issue draft carries label, files, timestamp and false-positive note",
			(() => {
				const groups = groupFactsBySubject([
					mk("a", "security", "HIGH: X", ["a.ts"]),
					mk("b", "security", "HIGH: X", ["b.ts"]),
				]);
				const draft = draftIssueForGroup(groups[0], { analyzedAt: "123", allGroups: groups });
				return (
					draft.title.startsWith("[Bug] ") &&
					draft.body.includes("`a.ts`") &&
					draft.body.includes("`b.ts`") &&
					draft.body.includes("`123`") &&
					draft.body.includes("false positive")
				);
			})(),
		],
		[
			"issue draft discloses shared files",
			(() => {
				const groups = groupFactsBySubject([
					mk("a", "security", "HIGH: X", ["shared.ts"]),
					mk("b", "dead-code", "Y()", ["shared.ts"]),
				]);
				const draft = draftIssueForGroup(groups[0], { analyzedAt: null, allGroups: groups });
				return (
					draft.body.includes("Best-effort isolation only") && draft.body.includes("Shared files")
				);
			})(),
		],
		[
			"readAnalyzedAt prefers the structured timestamp",
			readAnalyzedAt('{"analyzedAt":"2026-01-01T00:00:00Z"}', "**Analyzed:** yesterday") ===
				"2026-01-01T00:00:00Z",
		],
		[
			"readAnalyzedAt falls back to the markdown line",
			readAnalyzedAt(null, "**Analyzed:** 12.10.2026, 13:36:10") === "12.10.2026, 13:36:10",
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

	if (args.emitIssues) {
		// Grouped, template-appropriate issue drafts. Still creates nothing and
		// calls no `gh`; the confirmation gate decides what is filed.
		const groups =
			args.by === "group" ? groupFactsByFileGraph(candidates) : groupFactsBySubject(candidates);
		const analyzedAt = args.analyzedAt ?? readAnalyzedAt(json, markdown);
		const dir = resolve(repoRoot, args.emitIssuesDir ?? "ignore/codeflow-issue-drafts");
		const files = writeIssueFiles(dir, groups, { analyzedAt, allGroups: groups });
		process.stdout.write(
			`CodeFlow issue drafts — ${files.length} proposed issue(s) written to ${dir.replace(`${repoRoot}/`, "")}\n` +
				`grouping: ${args.by}\n` +
				`analyzedAt: ${analyzedAt ?? "(unknown — pass --analyzed-at)"}\n` +
				`dispositions: ${dispositionSummary(candidates)}\n` +
				`\nproposed set:\n${issueTable(groups)}\n` +
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
