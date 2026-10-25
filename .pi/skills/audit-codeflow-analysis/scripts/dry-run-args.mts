import {
	classifyFinding,
	hasStructuredFindings,
	reportUnparsedItems,
	type Disposition,
	type IssueFact,
	type IssueType,
	type SectionCoverage,
	type Target,
} from "../lib/report.ts";
import {
	draftIssue,
	resolveCited,
	indexBasenames,
	groupFactsBySubject,
	groupFactsByFileGraph,
	draftIssueForGroup,
	readAnalyzedAt,
} from "./dry-run-lib.mts";

export function parseArgs(argv: string[]): {
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

export function selfCheck(): number {
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
export function jsonNote(): string {
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
export function coverageReport(markdown: string, coverage: SectionCoverage[]): string {
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
