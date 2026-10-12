// ─── CodeFlow Markdown Report Parser ─────────────────────────────
// Pure markdown → IssueFact adapter. Split out of report.ts (issue #2001).
// Carries zero triage policy — classification and grouping stay in report.ts;
// this module only recovers targets from the exported markdown.

import type { IssueFact, Target } from "./report.ts";

/** Map a `## Section` heading to an issue kind, or null for non-issue sections. */
export function sectionKind(heading: string): string | null {
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
export function isPathLike(token: string): boolean {
	const t = token.trim();
	if (t === "" || /\s/.test(t)) return false;
	if (t.includes("/")) return true;
	return /\.[A-Za-z0-9]+$/.test(t);
}

/** `A → B` (or ASCII `A -> B`), the layer-violation shape the exporter emits. */
const LAYER_EDGE = /^(.+?)\s*(?:→|->)\s*(.+)$/;

/** A file-only projection of a target list, for the path-based helpers. */
export function fileTargets(files: string[]): Target[] {
	return files.map((path) => ({ kind: "file", path }));
}

export function targetKey(target: Target): string {
	return JSON.stringify(target);
}

/** Turn one backticked affected token into its target (path, edge or symbol). */
function tokenTarget(token: string): Target {
	const edge = LAYER_EDGE.exec(token);
	if (edge) return { kind: "layer-edge", from: edge[1].trim(), to: edge[2].trim() };
	if (isPathLike(token)) return { kind: "file", path: token };
	return { kind: "symbol", name: token };
}

/**
 * Drop a trailing display count the exporter inlines into an item's `name` for
 * the derived architecture metrics — `index.test.ts (46 fns)`, `capture.test.mts
 * (73 imports)`, `prune_test.go (206)`. The markdown format emits only
 * `x.name || x.file` (`generateReport('md')`), so without this the item's real
 * path is lost and the whitespace makes `isPathLike` reject the whole token,
 * silently dropping every architecture issue from the report.
 */
function stripTrailingCount(token: string): string {
	return token.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/** Is this line the `**Affected:**` / `**Files:**` reference line of an item? */
function isRefLine(line: string): boolean {
	const t = line.trim();
	return /^([-*]\s+)?\*\*(affected( files)?|files?|file)\s*:?\*\*/i.test(t);
}

/**
 * Every target a backticked reference line names, in order, deduped. A
 * path-shaped edge (`src/a.ts → src/b.ts`) is an edge, not two files: the layer
 * shape wins over the path check so the edge keeps its labels.
 */
export function targetsFromRefLine(line: string): Target[] {
	if (!isRefLine(line)) return [];
	const out: Target[] = [];
	const seen = new Set<string>();
	const re = /`([^`]+)`/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(line)) !== null) {
		const token = stripTrailingCount(m[1]);
		if (token === "") continue;
		const target = tokenTarget(token);
		const key = targetKey(target);
		if (!seen.has(key)) {
			seen.add(key);
			out.push(target);
		}
	}
	return out;
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
		if (current && current.targets.length > 0) {
			current.files = current.targets
				.filter((t): t is Extract<Target, { kind: "file" }> => t.kind === "file")
				.map((t) => t.path);
			facts.push(current);
		}
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
				current = {
					id: `${kind}:${n}`,
					kind,
					title: h3[1].replace(/`/g, "").trim(),
					targets: [],
					files: [],
				};
			}
			continue;
		}
		if (!kind || !current) continue;
		const desc = /^\s*[-*]?\s*\*\*Description:\*\*\s*(.+)$/i.exec(line);
		if (desc && !current.description) current.description = desc[1].trim();
		for (const target of targetsFromRefLine(line)) {
			const key = targetKey(target);
			if (!current.targets.some((t) => targetKey(t) === key)) current.targets.push(target);
		}
	}
	flush();
	return facts;
}
