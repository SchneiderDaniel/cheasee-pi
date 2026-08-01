// ─── Tests: pipeline/handler structure guards (issue #1395) ──────
// The split must not re-grow: S104 file-size ceiling, S138 function-size
// ceiling (with a documented exemption for the stage-machine loop), shim
// re-export contract, acyclic package graph, and erasable-syntax rules.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HANDLER_PKG = resolve(__dirname, "../../pipeline/handler");
const SHIM_TS = resolve(__dirname, "../../pipeline/handler.ts");
const PIPELINE_INDEX_TS = resolve(__dirname, "../../pipeline/index.ts");

const PACKAGE_FILES = [
	"index.ts",
	"preflight.ts",
	"agent-loop.ts",
	"post-pipeline.ts",
	"shared.ts",
];

function pkgSource(file: string): string {
	return readFileSync(resolve(HANDLER_PKG, file), "utf-8");
}

// Strip comments/strings/template literals (preserving newlines) so only
// real code braces are counted.
function stripLiterals(src: string): string {
	return src
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/`[^`]*`/g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/"[^"\n]*"/g, (m) => " ".repeat(m.length))
		.replace(/'[^'\n]*'/g, (m) => " ".repeat(m.length));
}

/** Line span of a top-level function (raw lines from `function` to body close). */
function functionLineSpan(
	file: string,
	name: string,
): { start: number; end: number; lines: number } {
	const stripped = stripLiterals(pkgSource(file));
	const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, "gm");
	const m = re.exec(stripped);
	assert.ok(m, `function ${name} not found in ${file}`);
	const start = stripped.slice(0, m.index).split("\n").length;

	const isTerminator = (line: string) => {
		const t = line.trim();
		return t === "" || /^(export|import|interface|type|function|async|class)\b/.test(t);
	};

	let depth = 0;
	let endOffset = -1;
	for (let i = m.index; i < stripped.length; i++) {
		const c = stripped[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				const firstNonBlank =
					stripped
						.slice(i + 1)
						.split("\n")
						.find((l) => l.trim().length > 0) || "";
				if (isTerminator(firstNonBlank)) {
					endOffset = i;
					break;
				}
			}
		}
	}
	assert.ok(endOffset >= 0, `could not find body close for ${name} in ${file}`);
	const end = stripped.slice(0, endOffset + 1).split("\n").length;
	return { start, end, lines: end - start + 1 };
}

/** All top-level function names in a file. */
function topLevelFunctions(file: string): string[] {
	const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gm;
	return [...pkgSource(file).matchAll(re)].map((m) => m[1]!);
}

// ---------------------------------------------------------------------------
// S104: file-size ceiling
// ---------------------------------------------------------------------------

describe("handler package — file size (S104)", () => {
	it("no file under pipeline/handler/ exceeds 1000 lines", () => {
		for (const file of PACKAGE_FILES) {
			const lines = pkgSource(file).split("\n").length;
			assert.ok(lines <= 1000, `${file} has ${lines} lines (> 1000)`);
		}
	});
});

// ---------------------------------------------------------------------------
// S138: function-size ceiling
// ---------------------------------------------------------------------------

describe("handler package — function size (S138)", () => {
	it("no top-level function exceeds 100 lines, except the documented runAgentLoop stage machine", () => {
		const LOOP_LIMIT = 800; // runAgentLoop: linear stage machine (see agent-loop.ts header)
		for (const file of PACKAGE_FILES) {
			for (const name of topLevelFunctions(file)) {
				const { start, end, lines } = functionLineSpan(file, name);
				if (name === "runAgentLoop") {
					assert.ok(
						lines <= LOOP_LIMIT,
						`runAgentLoop spans ${lines} lines (> ${LOOP_LIMIT}) in ${file}`,
					);
					continue;
				}
				assert.ok(
					lines <= 100,
					`${name} spans ${start}-${end} (${lines} lines) in ${file} — S138 ceiling (100) exceeded`,
				);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Shim + barrel contract
// ---------------------------------------------------------------------------

describe("handler.ts shim — re-export contract", () => {
	it("shim re-exports both handleSupervisorCommand and handlePostPipeline", () => {
		const shim = readFileSync(SHIM_TS, "utf-8");
		assert.ok(shim.includes("handleSupervisorCommand"), "shim re-exports handleSupervisorCommand");
		assert.ok(shim.includes("handlePostPipeline"), "shim re-exports handlePostPipeline");
		assert.ok(
			shim.includes('from "./handler/index.ts"'),
			"shim re-exports from the handler package barrel",
		);
	});

	it("pipeline/index.ts import is unchanged (still resolves through the shim)", () => {
		const src = readFileSync(PIPELINE_INDEX_TS, "utf-8");
		assert.ok(
			src.includes('import { handleSupervisorCommand } from "./handler.ts"'),
			"pipeline/index.ts keeps importing from ./handler.ts",
		);
	});

	it("orchestration: index.ts runs preflight → agent loop → post-pipeline in order", () => {
		const src = pkgSource("index.ts");
		const preflightIdx = src.indexOf("runPreflight(runCtx)");
		const loopIdx = src.indexOf("runAgentLoop(runCtx)");
		const postIdx = src.indexOf("runPostPipelinePhase(runCtx)");
		assert.ok(preflightIdx >= 0, "runPreflight called");
		assert.ok(loopIdx >= 0, "runAgentLoop called");
		assert.ok(postIdx >= 0, "runPostPipelinePhase called");
		assert.ok(preflightIdx < loopIdx && loopIdx < postIdx, "phase call order preserved");
	});

	it("single top-level try/catch/finally in runSupervisorPipeline", () => {
		const { start, end } = functionLineSpan("index.ts", "runSupervisorPipeline");
		const body = pkgSource("index.ts")
			.split("\n")
			.slice(start - 1, end);
		assert.ok(
			body.some((l) => l.includes("try {")),
			"try block present",
		);
		assert.ok(
			body.some((l) => l.includes("} catch (err: unknown) {")),
			"catch block present",
		);
		assert.ok(
			body.some((l) => l.includes("} finally {")),
			"finally block present",
		);
	});
});

// ---------------------------------------------------------------------------
// Package graph: acyclic, explicit re-exports
// ---------------------------------------------------------------------------

describe("handler package — acyclic imports", () => {
	it("preflight/agent-loop/post-pipeline never import each other or the barrel", () => {
		const phaseFiles = ["preflight.ts", "agent-loop.ts", "post-pipeline.ts"];
		const forbidden = ["./preflight.ts", "./agent-loop.ts", "./post-pipeline.ts", "./index.ts"];
		for (const file of phaseFiles) {
			const src = pkgSource(file);
			for (const target of forbidden) {
				assert.ok(
					!src.includes(`from "${target}"`),
					`${file} must not import ${target} (acyclic graph)`,
				);
			}
		}
	});

	it("phase modules consume shared.ts (RunContext / fetchResolvedByInfo)", () => {
		for (const file of ["preflight.ts", "agent-loop.ts", "post-pipeline.ts"]) {
			assert.ok(pkgSource(file).includes('from "./shared.ts"'), `${file} imports from shared.ts`);
		}
	});

	it("barrel uses explicit named re-exports, no `export *`", () => {
		for (const file of PACKAGE_FILES) {
			assert.ok(
				!pkgSource(file).includes("export * from"),
				`${file} must use explicit named re-exports`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// Erasable-syntax rules (node --experimental-strip-types)
// ---------------------------------------------------------------------------

describe("handler package — erasable TypeScript", () => {
	it("every relative import ends with .ts; no enums/namespaces/parameter properties", () => {
		for (const file of PACKAGE_FILES) {
			const src = pkgSource(file);
			// Relative imports must carry the explicit .ts extension.
			for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
				assert.ok(
					m[1]!.endsWith(".ts"),
					`${file}: relative import "${m[1]}" must end with .ts (allowImportingTsExtensions)`,
				);
			}
			assert.ok(!src.includes("enum "), `${file} must not use enums`);
			assert.ok(!src.includes("namespace "), `${file} must not use namespaces`);
			assert.ok(
				!src.includes("constructor("),
				`${file} must not use constructor parameter properties`,
			);
		}
	});
});
