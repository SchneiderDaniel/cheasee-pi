// ─── CodeFlow "Long File" metric mirror ───────────────────────────
// The pinned analyzer (`index.html` `detectPatterns`, ref below) emits the
// pattern as
//   longFiles = analyzed.filter(f => f.isCode !== false && f.lines && f.lines > 500)
// where `lines = content.split("\n").length` — a trailing newline counts, so a
// 500-newline file (501 segments) IS flagged. `isCode` gates files whose
// extension is absent from `codeExts`/`scriptContainerExts`: `.mts`, `.json`
// and `.md` are never scored.
//
// This non-test module holds the shared mirror so both the per-sibling oracle
// (`test/long-file-refactor-2005.test.mts`) and the recorded-envelope oracle
// (`test/codeflow-run-analysis.test.mts`) apply the exact same predicate. It is
// not named `*.test.mts`, so `node --test` never loads it as a suite.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The pinned analyzer ref the metric and the mirror were derived from. */
export const ANALYZER_REF = "b0e82d127fc4990f571ebc6da6c5d9af2591aaa1";

/** `index.html:1093` `Parser.codeExts` — `.mts`/`.json`/`.md` are absent by design. */
export const CODE_EXTS = [
	".js",
	".jsx",
	".ts",
	".tsx",
	".mjs",
	".cjs",
	".py",
	".pyw",
	".pyi",
	".java",
	".go",
	".rb",
	".php",
	".rs",
	".c",
	".cpp",
	".cc",
	".cxx",
	".h",
	".hpp",
	".hh",
	".hxx",
	".cs",
	".swift",
	".kt",
	".kts",
	".scala",
	".sc",
	".clj",
	".cljs",
	".cljc",
	".ex",
	".exs",
	".erl",
	".hrl",
	".hs",
	".lhs",
	".lua",
	".r",
	".R",
	".jl",
	".dart",
	".elm",
	".fs",
	".fsi",
	".fsx",
	".ml",
	".mli",
	".pl",
	".pm",
	".sh",
	".bash",
	".zsh",
	".fish",
	".ps1",
	".psm1",
	".psd1",
	".groovy",
	".gvy",
	".gradle",
	".vba",
	".bas",
	".cls",
	".xlsm",
	".xlam",
	".xlsb",
	".xla",
	".xlw",
	".pas",
	".pp",
	".dpr",
	".dpk",
	".lpr",
	".inc",
];

/** `lines = content.split("\n").length` — the analyzer's own segment count. */
export function lineCount(src: string): number {
	return src.split("\n").length;
}

/** The analyzer's `longFiles` predicate, including the `isCode` gate. */
export function isFlagged(src: string, rel: string): boolean {
	const ext = `.${rel.split(".").pop()}`;
	if (!CODE_EXTS.includes(ext)) return false;
	return lineCount(src) > 500;
}

/** The pinned metric measured over one tracked tree. */
export interface TreeMeasurement {
	/** Tracked file count (`git ls-tree -r --name-only` at the measured commit). */
	files: number;
	/** Tracked files whose extension the analyzer scores (`isCode !== false`). */
	codeFiles: number;
	/** Scored paths still over the ceiling, sorted. */
	flagged: string[];
}

/**
 * Measure the tracked files under `root` exactly the way the pinned analyzer
 * measures its snapshot: enumerate the tracked tree, score only members of
 * `CODE_EXTS`, and flag any that counts more than 500 segments. The delivered
 * tree is measured at test time, so a recorded envelope cannot drift from the
 * source it describes.
 */
export function measureWorktree(root: string): TreeMeasurement {
	const files = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
	const flagged: string[] = [];
	let codeFiles = 0;
	for (const rel of files) {
		if (!CODE_EXTS.includes(`.${rel.split(".").pop()}`)) continue;
		codeFiles++;
		if (isFlagged(readFileSync(resolve(root, rel), "utf-8"), rel)) flagged.push(rel);
	}
	return { files: files.length, codeFiles, flagged: flagged.sort() };
}
