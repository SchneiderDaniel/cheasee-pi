#!/usr/bin/env node
/**
 * Dry run of the codeflow-analysis skill.
 *
 * Extracts the first N findings from the CodeFlow report, validates each one
 * with the read-only subagent in `validate-finding.sh`, and PRINTS the issue it
 * would file — or the reason the finding is false. Nothing is created: this
 * script never calls `gh`.
 *
 * Usage:
 *   node --experimental-strip-types .pi/skills/audit-codeflow-analysis/scripts/dry-run.mts
 *   ... --limit 5 --report ignore/codeflow-report.md --json ignore/codeflow-report.json
 *   ... --self-check
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	dedupeIssues,
	parseBestReport,
	reportSectionCoverage,
	type IssueFact,
} from "../../../extensions/codeflow-analysis/report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(HERE, "validate-finding.sh");
const MAX_PARALLEL = 4;

// ─── Pure helpers (covered by --self-check) ───────────────────────

export function parseVerdict(output: string): "VALID" | "INVALID" | "UNKNOWN" {
	const m = /^VERDICT:[ \t]*(VALID|INVALID)[ \t]*$/m.exec(output);
	return m ? (m[1] as "VALID" | "INVALID") : "UNKNOWN";
}

/** Last line starting with `prefix`, value only ("" when absent). */
export function verdictDetail(output: string, prefix: string): string {
	const lines = output
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith(`${prefix}:`));
	const last = lines[lines.length - 1];
	return last ? last.slice(prefix.length + 1).trim() : "";
}

export function draftIssue(fact: IssueFact, sourceLabel: string): { title: string; body: string } {
	const files = fact.files.length > 0 ? fact.files : ["(no file — derived signal)"];
	const cited = files.map((f) => (f.startsWith("(") ? f : `\`${f}\``)).join(", ");
	return {
		title: `[Bug] CodeFlow ${fact.kind}: ${fact.title}`,
		body: [
			"## Describe the bug",
			`CodeFlow reports **${fact.title}** (kind: \`${fact.kind}\`) in ${cited}.`,
			"",
			"## Expected behavior",
			"The finding no longer applies once the cited code is addressed.",
			"",
			"## Additional context",
			`- Source: CodeFlow ${sourceLabel} finding \`${fact.id}\``,
			`- Files: ${cited}`,
			"- Verified against the source by a read-only subagent (VERDICT: VALID, exit 0).",
		].join("\n"),
	};
}

function renderResolved(file: string, r: FileResolution): string {
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

// ─── Validation run ───────────────────────────────────────────────

interface Validation {
	fact: IssueFact;
	exitCode: number | null;
	output: string;
}

function runValidator(
	findingPath: string,
	repoRoot: string,
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(VALIDATOR, [findingPath, repoRoot], {
			cwd: repoRoot,
			// Explicit stdin: a piped-but-never-closed stdin makes `pi` read the prompt
			// from stdin instead of argv, which yields an empty, non-zero run.
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (d: Buffer) => (output += d.toString()));
		child.stderr.on("data", (d: Buffer) => (output += d.toString()));
		child.on("error", (err: Error) =>
			resolvePromise({ code: null, output: `${output}\nspawn failed: ${err.message}` }),
		);
		child.on("close", (code) => resolvePromise({ code, output }));
	});
}

/** Run tasks with a fixed concurrency cap, preserving input order. */
async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// ─── CLI ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
	limit: number;
	report: string;
	json: string | null;
	selfCheck: boolean;
	listOnly: boolean;
} {
	const out = {
		limit: 5,
		report: "ignore/codeflow-report.md",
		json: null as string | null,
		selfCheck: false,
		listOnly: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--self-check") out.selfCheck = true;
		else if (arg === "--list") out.listOnly = true;
		else if (arg === "--limit") out.limit = Number(argv[++i]);
		else if (arg === "--report") out.report = argv[++i];
		else if (arg === "--json") out.json = argv[++i];
		else if (arg === "--help" || arg === "-h") {
			process.stdout.write(
				"usage: dry-run.mts [--limit N] [--report FILE] [--json FILE] [--list] [--self-check]\n" +
					"  --list  extract findings and resolve cited files only (no subagents)\n",
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
		["VALID verdict", parseVerdict("blah\nVERDICT: VALID\nEVIDENCE: a.ts:1") === "VALID"],
		["INVALID verdict", parseVerdict("VERDICT: INVALID\nREASON: nope") === "INVALID"],
		["missing verdict", parseVerdict("no verdict here") === "UNKNOWN"],
		["reason extraction", verdictDetail("REASON: one\nREASON: two\n", "REASON") === "two"],
		[
			"draft carries files",
			draftIssue(
				{ id: "security:0", kind: "security", title: "HIGH: X", files: ["a/b.ts"] },
				"markdown",
			).body.includes("`a/b.ts`"),
		],
		[
			"draft handles file-less fact",
			draftIssue(
				{ id: "suggestion:0", kind: "suggestion", title: "Split module", files: [] },
				"markdown",
			).body.includes("(no file"),
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

function lastMeaningfulLine(output: string): string {
	const lines = output
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("```"));
	return lines[lines.length - 1] ?? "(no output)";
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
	const json = existsSync(jsonPath) ? readFileSync(jsonPath, "utf-8") : null;
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
	const selected = unique.slice(0, args.limit);

	const basenameIndex = indexBasenames(
		execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf-8" })
			.split("\n")
			.filter((l) => l !== ""),
	);
	const resolveFile = (file: string): FileResolution =>
		resolveCited((p) => existsSync(resolve(repoRoot, p)), basenameIndex, file);

	if (args.listOnly) {
		const cited = selected.flatMap((f) => f.files).map(resolveFile);
		for (const [i, fact] of selected.entries()) {
			const files =
				fact.files.length > 0
					? fact.files.map((f) => renderResolved(f, resolveFile(f))).join(", ")
					: "(none)";
			process.stdout.write(`[${i + 1}] ${fact.kind} — ${fact.title}\n      files: ${files}\n`);
		}
		const unresolved = cited.filter((r) => r.how === "unresolved");
		process.stdout.write(
			"\nsection coverage (### items the exporter emitted vs candidates parsed):\n",
		);
		for (const c of coverage) {
			const flag = c.items > 0 && c.candidates === 0 ? "  <-- UNREADABLE" : "";
			process.stdout.write(
				`  ${c.heading}: ${c.items} item(s), ${c.candidates} candidate(s)${flag}\n`,
			);
		}
		process.stdout.write(
			`\n${selected.length} finding(s), ${cited.length} cited file(s), ${cited.length - unresolved.length} found, ` +
				`${unresolved.length} unresolved. No validation run, no issues created.\n`,
		);
		process.exit(0);
	}

	const sourceLabel = json ? "json" : "markdown";
	process.stdout.write(
		`CodeFlow dry run — ${reportPath.replace(`${repoRoot}/`, "")} (${sourceLabel}, ` +
			`${facts.length} finding(s), ${unique.length} unique, ${facts.length - unique.length} duplicate(s) dropped)\n` +
			`Validating first ${selected.length} unique finding(s), ${MAX_PARALLEL} in parallel. No issues are created.\n\n`,
	);

	const findingsDir = join(repoRoot, "ignore/codeflow-findings");
	mkdirSync(findingsDir, { recursive: true });
	const findingFiles = selected.map((fact, i) => {
		const slug = `${fact.kind}-${i + 1}`;
		const file = join(findingsDir, `${slug}.md`);
		writeFileSync(
			file,
			[
				`# CodeFlow finding (${fact.kind})`,
				"",
				`**Title:** ${fact.title}`,
				`**Id:** ${fact.id}`,
				`**Files:** ${fact.files.length > 0 ? fact.files.join(", ") : "(none)"}`,
				"",
				"The markdown/inspection export carries no description; read the cited code and",
				"decide whether the finding is real.",
			].join("\n"),
			"utf-8",
		);
		return file;
	});

	let validations: Validation[];
	try {
		validations = await mapLimit(
			findingFiles,
			MAX_PARALLEL,
			async (file, i): Promise<Validation> => {
				const result = await runValidator(file, repoRoot);
				return { fact: selected[i], exitCode: result.code, output: result.output };
			},
		);
	} finally {
		rmSync(findingsDir, { recursive: true, force: true });
	}

	let valid = 0;
	let invalid = 0;
	let unverified = 0;

	validations.forEach((v, i) => {
		const verdict = v.exitCode === 0 ? "VALID" : v.exitCode === 1 ? "INVALID" : "UNKNOWN";
		const files =
			v.fact.files.length > 0
				? v.fact.files.map((f) => renderResolved(f, resolveFile(f))).join(", ")
				: "(none)";
		process.stdout.write(
			`[${i + 1}/${validations.length}] ${v.fact.kind} — ${v.fact.title}\n      files: ${files}\n`,
		);

		if (verdict === "VALID") {
			valid++;
			const draft = draftIssue(v.fact, sourceLabel);
			process.stdout.write(`      VALID (exit 0) — would file:\n`);
			process.stdout.write(`      Title: ${draft.title}\n`);
			for (const line of draft.body.split("\n")) process.stdout.write(`      │ ${line}\n`);
			process.stdout.write(
				`      Evidence: ${verdictDetail(v.output, "EVIDENCE") || "(none reported)"}\n\n`,
			);
		} else if (verdict === "INVALID") {
			invalid++;
			process.stdout.write(`      FALSE FINDING (exit 1) — dropped, not filed\n`);
			process.stdout.write(
				`      Reason: ${verdictDetail(v.output, "REASON") || lastMeaningfulLine(v.output)}\n`,
			);
			const evidence = verdictDetail(v.output, "EVIDENCE");
			if (evidence) process.stdout.write(`      Evidence: ${evidence}\n`);
			process.stdout.write("\n");
		} else {
			unverified++;
			process.stdout.write(`      UNVERIFIED (exit ${v.exitCode}) — not filed\n`);
			for (const line of v.output.split("\n")) process.stdout.write(`      │ ${line}\n`);
			process.stdout.write("\n");
		}
	});

	const cited = validations.flatMap((v) => v.fact.files).map(resolveFile);
	const byBasename = cited.filter((r) => r.how === "basename").length;
	const unresolved = cited.filter((r) => r.how === "unresolved");
	process.stdout.write(
		`Summary: ${validations.length} checked — ${valid} valid (would file ${valid} issue(s)), ` +
			`${invalid} false finding(s) dropped, ${unverified} unverified.\n` +
			`Codebase link: ${cited.length - unresolved.length}/${cited.length} cited file(s) found` +
			`${byBasename > 0 ? ` (${byBasename} by basename)` : ""}` +
			`${unresolved.length > 0 ? `; unresolved: ${unresolved.map((r) => r.path).join(", ")}` : ""}.\n` +
			`No issues created (dry run).\n`,
	);
	process.exit(0);
}

main().catch((err: unknown) => {
	process.stderr.write(`dry run failed: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(2);
});
