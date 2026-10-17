import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	classifyFinding,
	groupIssues,
	type Disposition,
	type IssueFact,
	type IssueType,
	type SectionCoverage,
	type Target,
} from "../lib/report.ts";

export function draftIssue(
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
export function describeTargets(fact: IssueFact): string {
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

export function renderResolved(file: string, r: FileResolution): string {
	if (r.how === "exact") return r.path;
	if (r.how === "basename") return `${r.path} (basename of \`${file}\`)`;
	return `${file} (unresolved)`;
}

/** basename → repo path, preferring the shortest (deterministic) match. */
export function indexBasenames(paths: string[]): Map<string, string> {
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
export function resolveCited(
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
export function dispositionSummary(facts: IssueFact[]): string {
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
export function writeIssueFiles(dir: string, groups: DraftGroup[], ctx: DraftContext): string[] {
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
export function issueTable(groups: DraftGroup[]): string {
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
export function writeFindingFiles(dir: string, facts: IssueFact[]): string[] {
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
