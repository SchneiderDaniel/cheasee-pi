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
 * throws. Only facts with at least one file path participate in file-isolation
 * grouping; file-less facts (e.g. suggestions) are still surfaced as isolated
 * groups.
 *
 * Formats verified against CodeFlow b0e82d1
 * (`test/fixtures/generate-report-fixtures.mjs` regenerates the fixtures from
 * the real generator).
 */

export interface IssueFact {
	/** Stable id, unique within one parse (kind + per-kind index). */
	id: string;
	/** architecture | security | dead-code | duplicate | layer-violation | suggestion | pattern | anti-pattern */
	kind: string;
	title: string;
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

/** Map a `## Section` heading to an issue kind, or null for non-issue sections. */
function sectionKind(heading: string): string | null {
	const h = heading.trim().toLowerCase();
	if (/^architecture issues/.test(h)) return "architecture";
	if (/^security issues/.test(h)) return "security";
	if (/^unused functions/.test(h)) return "dead-code";
	if (/^anti-patterns/.test(h)) return "anti-pattern";
	if (/^design patterns/.test(h)) return "pattern";
	// Not emitted by the markdown exporter today, but recognised defensively in
	// case upstream adds the sections; JSON is the source for these categories.
	if (/^duplicate code/.test(h) || /^duplicates?\b/.test(h)) return "duplicate";
	if (/^layer violations?\b/.test(h)) return "layer-violation";
	if (/^suggestions?\b/.test(h) || /^recommendations?\b/.test(h)) return "suggestion";
	return null;
}

/** A backticked token that names a file path (has a separator or an extension). */
function isPathLike(token: string): boolean {
	const t = token.trim();
	if (t === "" || /\s/.test(t)) return false;
	if (t.includes("/")) return true;
	return /\.[A-Za-z0-9]+$/.test(t);
}

/** Every path-like token in a line's backticks, in order. */
function backtickPaths(line: string): string[] {
	const out: string[] = [];
	const re = /`([^`]+)`/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(line)) !== null) {
		if (isPathLike(m[1])) out.push(m[1].trim());
	}
	return out;
}

/** A line that carries file references for the enclosing `###` item. */
function pathsFromRefLine(line: string): string[] {
	const t = line.trim();
	if (/^([-*]\s+)?\*\*(affected( files)?|files?|file)\s*:?\*\*/i.test(t)) return backtickPaths(t);
	return [];
}

/**
 * Parse a CodeFlow markdown report into issue facts. Returns [] for empty,
 * unknown, or truncated input; never throws.
 */
export function parseReport(markdown: string): IssueFact[] {
	const facts: IssueFact[] = [];
	const counters = new Map<string, number>();
	let kind: string | null = null;
	let current: IssueFact | null = null;

	const flush = () => {
		if (current && current.files.length > 0) facts.push(current);
		current = null;
	};

	for (const raw of (markdown ?? "").split("\n")) {
		const line = raw.replace(/\r$/, "");
		const h2 = /^##\s+(.*)$/.exec(line);
		if (h2) {
			flush();
			kind = sectionKind(h2[1]);
			continue;
		}
		const h3 = /^###\s+(.*)$/.exec(line);
		if (h3) {
			flush();
			if (kind) {
				const n = counters.get(kind) ?? 0;
				counters.set(kind, n + 1);
				current = { id: `${kind}:${n}`, kind, title: h3[1].replace(/`/g, "").trim(), files: [] };
			}
			continue;
		}
		if (!kind || !current) continue;
		for (const p of pathsFromRefLine(line)) {
			if (!current.files.includes(p)) current.files.push(p);
		}
	}
	flush();
	return facts;
}

/** Append unique, non-empty strings (whitespace trimmed). */
function addFiles(target: string[], values: unknown): void {
	for (const v of Array.isArray(values) ? values : []) {
		if (typeof v !== "string") continue;
		const t = v.trim();
		if (t !== "" && !target.includes(t)) target.push(t);
	}
}

/** Build a fact list from the structured JSON report. Defensive per array. */
export function parseReportJson(text: string): IssueFact[] {
	let root: unknown;
	try {
		root = JSON.parse(text ?? "");
	} catch {
		return [];
	}
	if (root === null || typeof root !== "object" || Array.isArray(root)) return [];
	const r = root as Record<string, unknown>;

	const facts: IssueFact[] = [];
	const counters = new Map<string, number>();
	const push = (kind: string, title: string, files: string[]): void => {
		const n = counters.get(kind) ?? 0;
		counters.set(kind, n + 1);
		facts.push({ id: `${kind}:${n}`, kind, title, files });
	};

	for (const issue of Array.isArray(r.architectureIssues) ? r.architectureIssues : []) {
		const i = issue as Record<string, unknown>;
		const files: string[] = [];
		// affectedFiles is the generator's flattened `x.file || x.name`.
		addFiles(files, i.affectedFiles);
		// The generator drops `toFile` when flattening affectedFiles, but a
		// layer-violation item carries the imported target there. Include both
		// endpoints of every affected item or the target file is missing from
		// the file-conflict graph (an issue touching it would group separately).
		for (const item of Array.isArray(i.affectedItems) ? i.affectedItems : []) {
			const a = item as Record<string, unknown>;
			addFiles(files, [a.file, a.toFile]);
		}
		push("architecture", String(i.title ?? "").trim(), files);
	}
	for (const dup of Array.isArray(r.duplicates) ? r.duplicates : []) {
		const d = dup as Record<string, unknown>;
		const files: string[] = [];
		for (const f of Array.isArray(d.files) ? d.files : []) {
			addFiles(files, [(f as Record<string, unknown>)?.file]);
		}
		const label = d.type === "code" ? "Similar Code" : "Same Name";
		push("duplicate", `${label}: ${String(d.name ?? "").trim()}`, files);
	}
	for (const v of Array.isArray(r.layerViolations) ? r.layerViolations : []) {
		const lv = v as Record<string, unknown>;
		const files: string[] = [];
		addFiles(files, [lv.from, lv.to]);
		const edge = `${String(lv.fromLayer ?? "")} → ${String(lv.toLayer ?? "")}`.trim();
		push("layer-violation", edge, files);
	}
	for (const s of Array.isArray(r.suggestions) ? r.suggestions : []) {
		// Suggestions are derived targets with no file of their own; kept so the
		// skill can still surface them, grouped in isolation.
		push("suggestion", String((s as Record<string, unknown>)?.title ?? "").trim(), []);
	}
	for (const fn of Array.isArray(r.unusedFunctions) ? r.unusedFunctions : []) {
		const f = fn as Record<string, unknown>;
		const files: string[] = [];
		addFiles(files, [f.file]);
		push("dead-code", `${String(f.name ?? "").trim()}()`, files);
	}
	for (const s of Array.isArray(r.securityIssues) ? r.securityIssues : []) {
		const sec = s as Record<string, unknown>;
		const files: string[] = [];
		addFiles(files, [sec.path]);
		const sev = String(sec.severity ?? "").toUpperCase();
		push("security", `${sev}: ${String(sec.title ?? "").trim()}`.trim(), files);
	}
	// Design patterns and anti-patterns. The markdown exporter emits these too,
	// so the JSON source must carry them as well or they are dropped whenever the
	// structured artifact is present (parseBestReport prefers JSON).
	for (const pat of Array.isArray(r.patterns) ? r.patterns : []) {
		const p = pat as Record<string, unknown>;
		const files: string[] = [];
		addFiles(files, p.files);
		for (const f of Array.isArray(p.fileDetails) ? p.fileDetails : []) {
			addFiles(files, [(f as Record<string, unknown>)?.path]);
		}
		push(p.isAntiPattern === true ? "anti-pattern" : "pattern", String(p.name ?? "").trim(), files);
	}
	return facts;
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
