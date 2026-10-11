// ─── CodeFlow JSON Report Parser ─────────────────────────────────
// Pure JSON → IssueFact adapter. Split out of report.ts (issue #2001).
// Carries zero triage policy — it only reads the structured export.

import type { IssueFact } from "./report.ts";
import { fileTargets, isPathLike } from "./report-markdown.ts";

/** Append unique, non-empty strings (whitespace trimmed). */
function addFiles(target: string[], values: unknown): void {
	for (const v of Array.isArray(values) ? values : []) {
		if (typeof v !== "string") continue;
		const t = v.trim();
		if (t !== "" && !target.includes(t)) target.push(t);
	}
}

/**
 * Narrow an unknown value to a plain object, or null for primitives, arrays and
 * null. Report arrays are attacker/format-controlled, so every entry must pass
 * this before its fields are read (`[null]` must not abort the whole parse).
 */
function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
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
		facts.push({ id: `${kind}:${n}`, kind, title, targets: fileTargets(files), files });
	};

	for (const issue of Array.isArray(r.architectureIssues) ? r.architectureIssues : []) {
		const i = asRecord(issue);
		if (!i) continue;
		const files: string[] = [];
		// affectedFiles is the generator's flattened `x.file || x.name`; for
		// symbol-level items it holds display strings (`execFn (3 files)`), so keep
		// only path-shaped entries and recover the real paths from the nested shape.
		const affected = i.affectedFiles;
		if (Array.isArray(affected)) {
			addFiles(
				files,
				affected.filter((v) => typeof v === "string" && isPathLike(v)),
			);
		}
		// The generator drops `toFile` when flattening affectedFiles, but a
		// layer-violation item carries the imported target there. Include both
		// endpoints of every affected item or the target file is missing from
		// the file-conflict graph (an issue touching it would group separately).
		for (const item of Array.isArray(i.affectedItems) ? i.affectedItems : []) {
			const a = asRecord(item);
			if (!a) continue;
			addFiles(files, [a.file, a.toFile]);
			// A third, nested shape is used for the `Duplicate Function Names` and
			// `Similar Code Blocks` items: affectedItems[].files[].file. Without it
			// those items keep only display strings and are suppressed as unresolved.
			for (const f of Array.isArray(a.files) ? a.files : []) {
				addFiles(files, [asRecord(f)?.file]);
			}
		}
		push("architecture", String(i.title ?? "").trim(), files);
	}
	for (const dup of Array.isArray(r.duplicates) ? r.duplicates : []) {
		const d = asRecord(dup);
		if (!d) continue;
		const files: string[] = [];
		for (const f of Array.isArray(d.files) ? d.files : []) {
			addFiles(files, [asRecord(f)?.file]);
		}
		const label = d.type === "code" ? "Similar Code" : "Same Name";
		push("duplicate", `${label}: ${String(d.name ?? "").trim()}`, files);
	}
	for (const v of Array.isArray(r.layerViolations) ? r.layerViolations : []) {
		const lv = asRecord(v);
		if (!lv) continue;
		const files: string[] = [];
		addFiles(files, [lv.from, lv.to]);
		const edge = `${String(lv.fromLayer ?? "")} → ${String(lv.toLayer ?? "")}`.trim();
		push("layer-violation", edge, files);
	}
	for (const s of Array.isArray(r.suggestions) ? r.suggestions : []) {
		const suggestion = asRecord(s);
		if (!suggestion) continue;
		// Suggestions are derived targets with no file of their own; kept so the
		// skill can still surface them, grouped in isolation.
		push("suggestion", String(suggestion.title ?? "").trim(), []);
	}
	for (const fn of Array.isArray(r.unusedFunctions) ? r.unusedFunctions : []) {
		const f = asRecord(fn);
		if (!f) continue;
		const files: string[] = [];
		addFiles(files, [f.file]);
		push("dead-code", `${String(f.name ?? "").trim()}()`, files);
	}
	for (const s of Array.isArray(r.securityIssues) ? r.securityIssues : []) {
		const sec = asRecord(s);
		if (!sec) continue;
		const files: string[] = [];
		addFiles(files, [sec.path]);
		const sev = String(sec.severity ?? "").toUpperCase();
		push("security", `${sev}: ${String(sec.title ?? "").trim()}`.trim(), files);
	}
	// Design patterns and anti-patterns. The markdown exporter emits these too,
	// so the JSON source must carry them as well or they are dropped whenever the
	// structured artifact is present (parseBestReport prefers JSON).
	for (const pat of Array.isArray(r.patterns) ? r.patterns : []) {
		const p = asRecord(pat);
		if (!p) continue;
		const files: string[] = [];
		addFiles(files, p.files);
		for (const f of Array.isArray(p.fileDetails) ? p.fileDetails : []) {
			addFiles(files, [asRecord(f)?.path]);
		}
		push(p.isAntiPattern === true ? "anti-pattern" : "pattern", String(p.name ?? "").trim(), files);
	}
	return facts;
}
