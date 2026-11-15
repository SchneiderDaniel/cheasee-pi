// ─── LOW "Code Comments" hygiene finding (issue #2085) ───────────────────────
// CodeFlow raised `LOW: Code Comments` over the 21 paths pinned below, reporting
// between 1 and 10 unresolved-work markers per file. The finding is a
// path-class false positive, not deferred work:
//
//   (a) no shipping source — `.pi/extensions/**` and `cmd/**` outside `test/`,
//       `*.test.*`, `*.spec.*` and `*.md` — carries a marker at all;
//   (b) every cited path is a test artifact, where the token is the domain data
//       the tool tests assert on (ripgrep queries, rejected analyzer patterns,
//       rendered tool-call lines), or a documentation artifact, where it is
//       teaching prose about markers.
//
// Rewording the cited files is therefore not a fix: it would delete the values
// the assertions compare against and the prose the skills document. The fix
// lives in the adapter's path-class rule, `isFalsePositiveHygiene` in
// `cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js`, which suppresses LOW
// findings on test and doc paths.
//
// The existing suites (`codeflow-fp-filter.test.mts`,
// `codeflow-fp-filter-part6.test.mts`) already pin each path CLASS. This file
// pins the exact SET issue #2085 reported, closing the drift the architecture
// note called out as unguarded: narrowing the rule, or moving one of these files
// out of its class, now fails here instead of silently resurrecting the finding.
//
// Run: node --experimental-strip-types --test test/codeflow-fp-hygiene-2085.test.mts

import assert from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FILTER = resolve(ROOT, "cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js");

const requireCjs = createRequire(import.meta.url);
const { isFalsePositiveHygiene } = requireCjs(FILTER) as {
	isFalsePositiveHygiene: (issue: unknown, readFile?: (path: unknown) => string | null) => boolean;
};

/** The 21 files the #2085 CodeFlow report cites, in report order. */
const CITED = [
	".pi/extensions/agent-harness/test/index.test.ts",
	".pi/extensions/ripgrep-search/README.md",
	".pi/extensions/ripgrep-search/test/ripgrep-search-annotations.test.mts",
	".pi/extensions/ripgrep-search/test/ripgrep-search-cache-count.test.mts",
	".pi/extensions/ripgrep-search/test/ripgrep-search-execute-structured.test.mts",
	".pi/extensions/ripgrep-search/test/ripgrep-search-integration-rg.test.mts",
	".pi/extensions/ripgrep-search/test/ripgrep-search-schema.test.mts",
	".pi/extensions/ripgrep-search/test/ripgrep-search.test.mts",
	".pi/extensions/structural-analyzer/README.md",
	".pi/extensions/structural-analyzer/test/directory-traversal.test.mts",
	".pi/extensions/structural-analyzer/test/index.test.mts",
	".pi/extensions/structural-analyzer/test/validate.test.mts",
	".pi/extensions/supervisor/test/agent-output-part4.test.mts",
	".pi/extensions/supervisor/test/github/comment-part2.test.mts",
	".pi/extensions/supervisor/test/pipeline-worktree-integration.test.mts",
	".pi/extensions/supervisor/test/render-tool-call.test.mts",
	".pi/skills/audit-clean-code/SKILL.md",
	".pi/skills/audit-code-simplification/SKILL.md",
	"APPEND_SYSTEM.md",
	"test/codeflow-fp-acceptance.test.mts",
	"test/codeflow-fp-filter.test.mts",
];

/**
 * The cited files that carry a `TODO`/`FIXME`/`HACK` token today, with the count
 * recorded at review time. Only presence is asserted below — the counts are
 * context for the next reader, and a legitimate edit may lower them.
 */
const TOKEN_BEARING: Array<[path: string, recorded: number]> = [
	[".pi/extensions/agent-harness/test/index.test.ts", 2],
	[".pi/extensions/ripgrep-search/README.md", 1],
	[".pi/extensions/ripgrep-search/test/ripgrep-search-annotations.test.mts", 3],
	[".pi/extensions/ripgrep-search/test/ripgrep-search-cache-count.test.mts", 3],
	[".pi/extensions/ripgrep-search/test/ripgrep-search-execute-structured.test.mts", 5],
	[".pi/extensions/ripgrep-search/test/ripgrep-search-integration-rg.test.mts", 3],
	[".pi/extensions/ripgrep-search/test/ripgrep-search-schema.test.mts", 5],
	[".pi/extensions/ripgrep-search/test/ripgrep-search.test.mts", 4],
	[".pi/extensions/structural-analyzer/README.md", 2],
	[".pi/extensions/structural-analyzer/test/directory-traversal.test.mts", 1],
	[".pi/extensions/structural-analyzer/test/index.test.mts", 1],
	[".pi/extensions/structural-analyzer/test/validate.test.mts", 3],
	[".pi/extensions/supervisor/test/agent-output-part4.test.mts", 1],
	[".pi/extensions/supervisor/test/github/comment-part2.test.mts", 1],
	[".pi/extensions/supervisor/test/render-tool-call.test.mts", 10],
	[".pi/skills/audit-clean-code/SKILL.md", 6],
	[".pi/skills/audit-code-simplification/SKILL.md", 3],
	["test/codeflow-fp-acceptance.test.mts", 3],
	["test/codeflow-fp-filter.test.mts", 5],
];

/** A LOW hygiene finding exactly as the analyzer emits these: no snippet. */
function hygieneFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		severity: "low",
		title: "Code Comments",
		description: "Unresolved work marker found.",
		path: CITED[0],
		line: 1,
		code: "",
		...over,
	};
}

const nullReadFile = (): null => null;

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

const SOURCE_ROOTS = [".pi/extensions", "cmd"];
const SOURCE_EXTS = new Set([".ts", ".mts", ".js", ".mjs", ".go", ".rs"]);
const ARTIFACT_DIRS = new Set(["test", "tests", "__tests__", "docs"]);
const ARTIFACT_FILE = /\.(?:test|spec)\.[^./]+$/;
const MARKER_COMMENT = /(?:\/\/|#|\/\*|\*)[ \t]*(?:TODO|FIXME|HACK)\b/;

type Hit = { path: string; line: number; text: string };

/** Every comment-form marker in shipping source under `root`, tests and docs excluded. */
function scanShippingSources(root: string): Hit[] {
	const hits: Hit[] = [];
	const walk = (relDir: string): void => {
		for (const entry of readdirSync(resolve(ROOT, relDir), { withFileTypes: true })) {
			const rel = `${relDir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === ".git") continue;
				if (ARTIFACT_DIRS.has(entry.name)) continue;
				walk(rel);
				continue;
			}
			if (!SOURCE_EXTS.has(extname(entry.name))) continue;
			if (ARTIFACT_FILE.test(entry.name)) continue;
			read(rel)
				.split("\n")
				.forEach((text, index) => {
					if (MARKER_COMMENT.test(text)) {
						hits.push({ path: rel, line: index + 1, text: text.trim() });
					}
				});
		}
	};
	walk(root);
	return hits;
}

describe("CodeFlow LOW hygiene finding — issue #2085", () => {
	describe("the cited set is suppressed by the path-class rule", () => {
		it("suppresses the finding on all 21 cited paths", () => {
			for (const path of CITED) {
				assert.strictEqual(
					isFalsePositiveHygiene(hygieneFinding({ path }), nullReadFile),
					true,
					`${path} must classify as a non-shipping artifact`,
				);
			}
		});

		it("classifies by path alone, never by reading the cited file", () => {
			// A rule that consulted content could suppress a real marker that
			// happens to share a path class, so content must stay irrelevant.
			const unreadable = (): never => {
				throw new Error("the hygiene rule must not read the cited file");
			};
			for (const path of CITED) {
				assert.strictEqual(
					isFalsePositiveHygiene(hygieneFinding({ path }), unreadable),
					true,
					path,
				);
			}
		});

		it("keeps the negative controls, so the rule is not vacuous", () => {
			assert.strictEqual(
				isFalsePositiveHygiene(
					hygieneFinding({ path: ".pi/extensions/structural-analyzer/index.ts" }),
					nullReadFile,
				),
				false,
				"shipping source keeps its marker findings",
			);
			for (const severity of ["medium", "high", "critical"]) {
				assert.strictEqual(
					isFalsePositiveHygiene(
						hygieneFinding({ severity, path: "src/widget.test.ts" }),
						nullReadFile,
					),
					false,
					`${severity} severity is out of the LOW rule's scope`,
				);
			}
			for (const title of ["Code Comment", "code comments", "Code Comments "]) {
				assert.strictEqual(
					isFalsePositiveHygiene(
						hygieneFinding({ title, path: "src/widget.test.ts" }),
						nullReadFile,
					),
					false,
					`title ${JSON.stringify(title)} matches no emitted title`,
				);
			}
		});
	});

	describe("the cited set still matches the report", () => {
		it("every cited path still exists", () => {
			// A rename would leave the suppression assertions above passing
			// against a stale list while the finding reappears on the new path.
			for (const path of CITED) assert.ok(existsSync(resolve(ROOT, path)), `${path} is missing`);
		});

		it("every cited path is a test or documentation artifact", () => {
			const artifact = (path: string): boolean => {
				const segments = path.split("/");
				const name = segments[segments.length - 1];
				const inArtifactDir = segments
					.slice(0, -1)
					.some((s) => s === "test" || s === "tests" || s === "__tests__" || s === "docs");
				return inArtifactDir || /\.(?:test|spec)\.[^./]+$/.test(name) || /\.(?:md|mdx)$/.test(name);
			};
			for (const path of CITED) {
				assert.strictEqual(artifact(path), true, `${path} is shipping source, not an artifact`);
			}
		});
	});

	describe("the tokens stay where they belong", () => {
		it("every recorded fixture and doc path still carries its marker", () => {
			// Blind stripping is not the fix: these tokens are the inputs the
			// ripgrep/analyzer/supervisor tests compare against and the marker
			// vocabulary the skills teach. Losing one means the "fix" deleted
			// test coverage or documentation.
			for (const [path, recorded] of TOKEN_BEARING) {
				const found = read(path).match(/\b(?:TODO|FIXME|HACK)\b/g) ?? [];
				assert.ok(
					found.length > 0,
					`${path} lost its marker token (recorded ${recorded} at review time)`,
				);
			}
		});

		it("keeps the XXXXXX placeholder fixture in the worktree integration test", () => {
			assert.match(
				read(".pi/extensions/supervisor/test/pipeline-worktree-integration.test.mts"),
				/XXXXX+/,
			);
		});

		it("keeps TODOs in APPEND_SYSTEM.md as a routing noun, not a work marker", () => {
			// "IF searching literal text, error messages, or TODOs" — a plural
			// noun naming a search target. Rewording it to dodge a scanner would
			// make the routing rule worse, so the token must stay.
			assert.match(read("APPEND_SYSTEM.md"), /\bTODOs\b/);
			assert.doesNotMatch(read("APPEND_SYSTEM.md"), /\b(?:TODO|FIXME|HACK)\b/);
		});
	});

	describe("shipping source carries no deferred-work marker", () => {
		it("finds no comment-form marker outside tests and docs", () => {
			// The finding can only recur on shipping source if a marker lands
			// there. This is the gate that keeps scope honest: it fails for a
			// real `// TODO` in shipping code, and never for the fixtures and
			// prose above, which live on excluded paths.
			const hits = SOURCE_ROOTS.flatMap(scanShippingSources);
			assert.deepStrictEqual(
				hits.map((h) => `${h.path}:${h.line}: ${h.text}`),
				[],
				"shipping source must not carry TODO/FIXME/HACK markers",
			);
		});
	});
});
