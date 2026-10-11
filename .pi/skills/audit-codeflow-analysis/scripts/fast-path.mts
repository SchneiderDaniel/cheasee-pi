#!/usr/bin/env node
/**
 * CLI adapter for the deterministic known-FP pre-filter (issue #2014).
 *
 * Reads one Step 3 candidate file (the fields `dry-run.mts --emit-findings`
 * writes), builds the `RepoPort` from this checkout (`fs` + `rg` + `ast-grep`),
 * and applies `evaluateFastPath`. Exit protocol, consumed by
 * `scripts/validate-finding.sh`:
 *
 *   1   a verdict was emitted on stdout (`VERDICT: INVALID` + `REASON:` +
 *       `EVIDENCE:` + `RULE: <id> (known-fp row N)`); the LLM is not spawned
 *   10  deferred — stdout is empty and the LLM validator must run
 *   2   usage error (missing finding file, bad repo root) — agent mistake
 *
 * There is no `0`: this adapter can only disprove. Every failure mode (tool
 * missing, unreadable file, unparsable finding, rule error) exits `10`, so an
 * unmatched or unprovable candidate always reaches the subagent.
 *
 * Adapter only: finding parsing, `rg`/`ast-grep`/`fs` evidence and rendering.
 * The rules themselves live in `lib/fast-path.ts`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	evaluateFastPath,
	languageFamily,
	stripStringLiterals,
	type Declaration,
	type InvalidVerdict,
	type Match,
	type RepoPort,
} from "../lib/fast-path.ts";
import type { IssueFact, Target } from "../lib/report.ts";

const EXIT_INVALID = 1;
const EXIT_DEFER = 10;
const EXIT_USAGE = 2;

/** ast-grep declaration kinds per language family, as of the pinned grammar set. */
const DECLARATION_KINDS: Record<string, { lang: string; kinds: string }> = {
	"js-ts": {
		lang: "ts",
		kinds:
			"function_declaration, method_definition, function_signature, method_signature, class_declaration, interface_declaration",
	},
	python: { lang: "python", kinds: "function_definition, class_definition" },
	rust: { lang: "rust", kinds: "function_item, function_signature_item, struct_item, trait_item" },
	go: { lang: "go", kinds: "function_declaration, method_declaration" },
	shell: { lang: "bash", kinds: "function_definition" },
};

/** A `declare`-block opener: its members exist only for the type checker. */
const DECLARE_BLOCK = /\bdeclare\s+(?:module|global|namespace)\b/;

/** The enclosing type header of a member declaration (owner attribution). */
const TYPE_HEADER =
	/^\s*(?:export\s+)?(?:abstract\s+)?(?:default\s+)?(?:declare\s+)?(?:pub\s+)?(?:class|interface|enum|namespace|module|trait|struct|impl|object)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

const DECLARED_NAME_PATTERNS: readonly RegExp[] = [
	/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
	/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)/,
	/^\s*func\s*(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/,
	/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/,
	/\b(?:class|interface|namespace|module|trait|struct|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
	/^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*[[(:]/,
];

/**
 * Run one probe tool; a missing binary or a crashing tool throws (=> defer).
 * `paths` is always explicit: with only a pattern and a non-tty stdin, `rg`
 * searches the stdin stream instead of the checkout and silently finds nothing.
 */
function runTool(cmd: string, args: string[], cwd: string): { status: number; stdout: string } {
	const res = spawnSync(cmd, args, { cwd, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
	if (res.error) throw new Error(`${cmd} unavailable: ${res.error.message}`);
	return { status: res.status ?? 1, stdout: res.stdout ?? "" };
}

/** Net brace delta of a line with its string literals removed. */
function braceDelta(line: string): number {
	let delta = 0;
	for (const ch of stripStringLiterals(line)) {
		if (ch === "{") delta++;
		else if (ch === "}") delta--;
	}
	return delta;
}

/** Brace depth *before* each line (0-based array), strings ignored. */
function braceDepths(lines: readonly string[]): number[] {
	const depths: number[] = [];
	let depth = 0;
	for (const line of lines) {
		depths.push(depth);
		depth += braceDelta(line);
	}
	return depths;
}

/** True when the declaration at `line` (0-based) sits in a `declare` block. */
function inDeclareBlock(lines: readonly string[], line: number): boolean {
	let depth = 0;
	let ambient = false;
	for (let i = 0; i < line && i < lines.length; i++) {
		depth += braceDelta(lines[i] as string);
		if (depth > 0 && DECLARE_BLOCK.test(lines[i] as string)) ambient = true;
		else if (depth <= 0) ambient = false;
	}
	return ambient;
}

/** The nearest enclosing type header, or null when it cannot be attributed. */
function enclosingOwner(depths: readonly number[], lines: readonly string[], line: number): string | null {
	const at = depths[line] ?? 0;
	for (let i = line - 1; i >= 0; i--) {
		if ((depths[i] ?? 0) >= at) continue;
		const m = TYPE_HEADER.exec(lines[i] as string);
		return m ? (m[1] as string) : null;
	}
	return null;
}

/** The name this declaration node declares, or null when it declares none. */
function declaredName(text: string): string | null {
	for (const pattern of DECLARED_NAME_PATTERNS) {
		const m = pattern.exec(text);
		if (m) return m[1] as string;
	}
	return null;
}

/** A declaration's text ends with a closing brace iff it carries a body. */
function hasBody(text: string): boolean {
	return text.trimEnd().endsWith("}");
}

/**
 * Build the evidence surface over one checkout. Nothing is checked eagerly:
 * a missing `rg`/`ast-grep` surfaces as a throw on first use, which
 * `evaluateFastPath` turns into a deferral.
 */
export function buildRepoPort(repoRoot: string): RepoPort {
	const fileCache = new Map<string, string | null | string[]>();

	/** Resolve a cited path inside the checkout; outside paths are unreadable. */
	const safePath = (path: string): string | null => {
		const abs = resolve(repoRoot, path);
		const root = resolve(repoRoot);
		return abs === root || abs.startsWith(`${root}/`) ? abs : null;
	};

	const lines = (path: string): string[] | null => {
		if (fileCache.has(path)) {
			const cached = fileCache.get(path);
			return typeof cached === "string" ? cached.split("\n") : null;
		}
		const abs = safePath(path);
		let text: string | null = null;
		if (abs !== null && existsSync(abs)) {
			try {
				text = readFileSync(abs, "utf-8");
			} catch {
				text = null;
			}
		}
		fileCache.set(path, text);
		return text === null ? null : text.split("\n");
	};

	const symbolFiles = (symbol: string): string[] => {
		const res = runTool(
			"rg",
			[
				"--files-with-matches",
				// A checkout may keep its code in dot-directories; without --hidden
				// every probe would silently miss them.
				"--hidden",
				"--no-messages",
				"--fixed-strings",
				"--word-regexp",
				"--",
				symbol,
				".",
			],
			repoRoot,
		);
		// rg exits 1 when nothing matched, which is a real answer: no files.
		if (res.status === 1) return [];
		if (res.status !== 0) throw new Error(`rg failed (exit ${res.status})`);
		return res.stdout.split("\n").filter((l) => l !== "");
	};

	const declarationsIn = (symbol: string): Declaration[] => {
		const out: Declaration[] = [];
		const byLang = new Map<string, { kinds: string; paths: string[] }>();
		for (const file of symbolFiles(symbol)) {
			const spec = DECLARATION_KINDS[languageFamily(file) ?? ""];
			if (!spec) continue;
			const group = byLang.get(spec.lang) ?? { kinds: spec.kinds, paths: [] };
			group.paths.push(file);
			byLang.set(spec.lang, group);
		}
		for (const [lang, group] of byLang) {
			const res = runTool(
				"ast-grep",
				["run", "--kind", group.kinds, "--lang", lang, "--json=stream", "--", ...group.paths],
				repoRoot,
			);
			if (res.status !== 0) throw new Error(`ast-grep failed (exit ${res.status})`);
			for (const line of res.stdout.split("\n")) {
				if (line.trim() === "") continue;
				const node = JSON.parse(line) as {
					text?: string;
					file?: string;
					range?: { start?: { line?: number } };
				};
				const text = node.text ?? "";
				const file = node.file ?? "";
				const line0 = node.range?.start?.line ?? -1;
				if (file === "" || line0 < 0) continue;
				if (declaredName(text) !== symbol) continue;
				const source = lines(file) ?? [];
				out.push({
					file,
					line: line0 + 1,
					owner: enclosingOwner(braceDepths(source), source, line0),
					hasBody: hasBody(text),
					ambient: file.endsWith(".d.ts") || inDeclareBlock(source, line0),
				});
			}
		}
		return out;
	};

	return {
		readFile(path: string): string | null {
			const source = lines(path);
			return source === null ? null : source.join("\n");
		},
		findDeclarations(symbol: string): Declaration[] {
			return declarationsIn(symbol);
		},
		grep(pattern: string, path?: string): Match[] {
			const args = [
				"--line-number",
				"--no-heading",
				"--hidden",
				"--no-messages",
				"--fixed-strings",
				"--word-regexp",
				"--",
				pattern,
			];
			if (path !== undefined) args.push(path);
			else args.push(".");
			const res = runTool("rg", args, repoRoot);
			if (res.status === 1) return [];
			if (res.status !== 0) throw new Error(`rg failed (exit ${res.status})`);
			const out: Match[] = [];
			for (const line of res.stdout.split("\n")) {
				if (line === "") continue;
				const first = line.indexOf(":");
				const second = line.indexOf(":", first + 1);
				if (first < 0 || second < 0) continue;
				out.push({
					file: line.slice(0, first),
					line: Number(line.slice(first + 1, second)),
					text: line.slice(second + 1),
				});
			}
			return out;
		},
	};
}

/** A rendered layer edge (`from → to`) in the `**Targets:**` line. */
const LAYER_EDGE = /^(.+?)\s*→\s*(.+)$/;

/** Read one `**Field:** value` line from a Step 3 candidate file. */
function field(text: string, name: string): string {
	const m = new RegExp(`^\\*\\*${name}:\\*\\*[ \t]*(.*)$`, "m").exec(text);
	return m ? (m[1] as string).trim() : "";
}

/**
 * Rebuild the finding projection from a Step 3 candidate file. Returns null
 * when the required fields are missing, which the CLI reports as a deferral —
 * a malformed candidate must still reach the LLM validator.
 */
function parseFinding(text: string): IssueFact | null {
	const kind = field(text, "Kind");
	const title = field(text, "Title");
	if (kind === "" || title === "") return null;
	const filesField = field(text, "Files");
	const files =
		filesField === "" || filesField === "(none)"
			? []
			: filesField
					.split(",")
					.map((f) => f.trim())
					.filter((f) => f !== "");
	const targets: Target[] = files.map((path) => ({ kind: "file" as const, path }));
	// The `**Targets:**` line renders a symbol as `sym` in backticks (a list can
	// share one span: `a, b`) and a layer edge bare as `from → to`. Both must be
	// recovered, or an edge/symbol fact would look target-less and be misread as a
	// zero-file derived fact.
	const listed = field(text, "Targets");
	for (const m of listed.matchAll(/`([^`]+)`/g)) {
		for (const name of (m[1] as string).split(",")) {
			const trimmed = name.trim();
			if (trimmed === "" || files.includes(trimmed)) continue;
			if (targets.some((t) => t.kind === "symbol" && t.name === trimmed)) continue;
			targets.push({ kind: "symbol", name: trimmed });
		}
	}
	for (const part of listed.replace(/`[^`]*`/g, ",").split(",")) {
		const edge = LAYER_EDGE.exec(part.trim());
		if (edge) {
			targets.push({
				kind: "layer-edge",
				from: (edge[1] as string).trim(),
				to: (edge[2] as string).trim(),
			});
		}
	}
	return { id: field(text, "Id") || `${kind}:0`, kind, title, targets, files };
}

interface CliIO {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

const PROCESS_IO: CliIO = {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
};

/** The `VERDICT:` block `validate-finding.sh` consumes. */
function renderVerdict(verdict: InvalidVerdict): string {
	return (
		`VERDICT: INVALID\n` +
		`REASON: ${verdict.reason}\n` +
		`EVIDENCE: ${verdict.evidence}\n` +
		`RULE: ${verdict.ruleId} (known-fp row ${verdict.row})\n`
	);
}

/** Run the CLI; returns the process exit code (1 verdict, 10 defer, 2 usage). */
async function runFastPathCli(argv: readonly string[], io: CliIO = PROCESS_IO): Promise<number> {
	const findingPath = argv[0];
	if (findingPath === undefined) {
		io.stderr("usage: fast-path.mts <finding.md> [repo-root]\n");
		return EXIT_USAGE;
	}
	const repoRoot = argv[1] ?? process.cwd();
	if (!existsSync(findingPath) || !existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
		io.stderr(`usage: fast-path.mts <finding.md> [repo-root] — not found: ${
			existsSync(findingPath) ? repoRoot : findingPath
		}\n`);
		return EXIT_USAGE;
	}
	const finding = parseFinding(readFileSync(findingPath, "utf-8"));
	if (finding === null) {
		io.stderr("finding file carries no Kind/Title — deferring to the LLM validator\n");
		return EXIT_DEFER;
	}
	const verdict = await evaluateFastPath(finding, buildRepoPort(repoRoot), (error) => {
		io.stderr(`fast-path evidence unavailable, deferring to the LLM validator: ${
			error instanceof Error ? error.message : String(error)
		}\n`);
	});
	if (verdict === null) return EXIT_DEFER;
	io.stdout(renderVerdict(verdict));
	return EXIT_INVALID;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await runFastPathCli(process.argv.slice(2));
}
