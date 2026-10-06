/**
 * CodeFlow markdown report — parser and file-conflict grouping (pure).
 *
 * The Codeflow UI's markdown export (`generateReport('md')`) is human-readable
 * text, not JSON, so the skill needs these pure helpers to turn it back into
 * issue facts and to decide which issues can be filed in isolation.
 *
 * The parser is deliberately defensive: the markdown format is owned by the
 * vendored UI and may change, so unknown/absent sections yield no facts and
 * truncated input never throws. Only facts with at least one file path are
 * emitted — a file-less issue cannot participate in file-isolation grouping.
 *
 * Formats parsed (from the bundled generator):
 *   ### <title>
 *   **Affected:** `path/a.ts`, `path/b.ts`      (architecture / suggestions)
 *   **Files:** `path/a.ts`                       (patterns / duplicates)
 *   **Affected files:** `path/a.ts`              (anti-patterns / layer violations)
 *   - **File:** `path/a.ts` (line N)             (security / unused functions)
 */

export interface IssueFact {
	/** Stable id, unique within one parse (kind + per-kind index). */
	id: string;
	/** architecture | security | dead-code | duplicate | layer-violation | suggestion */
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
