/**
 * dead-code-shared-prompts-unused-removal.test.mts — issue #1870
 *
 * Dead-code deletion in lib/shared-prompts.ts: module-private
 * `DEDUPLICATION_SCAN_INSTRUCTION` (zero readers, tsc TS6133). The dedup policy
 * is owned by the deterministic pipeline gate (`shouldSkipResearcher`), so the
 * orphan LLM instruction is deleted rather than exported/wired.
 *
 * No static import of the removed symbol — verification is by source read
 * (absence) plus dynamic `import()` of the surviving exported contract.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code-shared-prompts-unused-removal.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");

function readSource(relativePath: string): string {
	return readFileSync(resolve(EXT_ROOT, relativePath), "utf8");
}

describe("shared-prompts.ts — dead symbol deleted (source absence)", () => {
	const source = readSource("lib/shared-prompts.ts");

	it("DEDUPLICATION_SCAN_INSTRUCTION is gone", () => {
		assert.equal(source.includes("DEDUPLICATION_SCAN_INSTRUCTION"), false);
	});

	it("stale doc-comment is gone", () => {
		assert.equal(
			source.includes("Previously embedded in researcher.md, now a shared constant"),
			false,
		);
	});

	it("no secondary reader introduced anywhere under extensions/supervisor", () => {
		const hits: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = resolve(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "node_modules") continue;
					walk(full);
				} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) {
					if (entry.name === "dead-code-shared-prompts-unused-removal.test.mts") continue;
					if (readFileSync(full, "utf8").includes("DEDUPLICATION_SCAN_INSTRUCTION")) {
						hits.push(full);
					}
				}
			}
		};
		walk(EXT_ROOT);
		assert.deepEqual(hits, [], `unexpected reader(s): ${hits.join(", ")}`);
	});
});

describe("shared-prompts.ts — exported contract preserved (over-deletion guard)", () => {
	const source = readSource("lib/shared-prompts.ts");

	it("surviving exported surface remains", () => {
		for (const spec of [
			"TOOL_DISCIPLINE_SNIPPET",
			"ERROR_HANDLING_PRINCIPLES",
			"INVESTIGATION_EFFICIENCY",
			"COMMENT_FORMAT_TEMPLATES",
			"buildAgentSystemPrompt",
		]) {
			assert.equal(source.includes(spec), true, `${spec} must be kept`);
		}
	});

	it("runtime contract unchanged", async () => {
		const mod = await import("../lib/shared-prompts.ts");
		assert.ok(typeof mod.TOOL_DISCIPLINE_SNIPPET === "string");
		assert.ok(mod.TOOL_DISCIPLINE_SNIPPET.length > 0);
		for (const key of ["researcher", "architect", "test-designer"] as const) {
			assert.equal(typeof mod.COMMENT_FORMAT_TEMPLATES[key], "string", `${key} template`);
		}
		assert.equal(typeof mod.COMMENT_FORMAT_TEMPLATES.auditor.approved, "string");
		assert.equal(typeof mod.COMMENT_FORMAT_TEMPLATES.auditor.rejected, "string");
		const prompt = mod.buildAgentSystemPrompt("BASE", "researcher");
		assert.ok(prompt.includes("BASE"));
		assert.ok(prompt.includes(mod.TOOL_DISCIPLINE_SNIPPET));
	});
});

describe("pipeline/stages/core.ts — dedup policy owner intact", () => {
	const source = readSource("pipeline/stages/core.ts");

	it("shouldSkipResearcher / hasResearchFindings and docstring remain", () => {
		assert.equal(source.includes("shouldSkipResearcher"), true);
		assert.equal(source.includes("hasResearchFindings"), true);
		assert.equal(
			source.includes("replaces the LLM-instructed"),
			true,
			"dedup-gate docstring must survive",
		);
	});
});

describe("tsc gate — shared-prompts.ts clean under --noUnusedLocals", () => {
	// Fail closed: prove the compiler ran and actually processed the target file
	// before trusting the absence of diagnostics. `--listFiles` makes tsc print the
	// program's file set, so a launch/configuration failure cannot masquerade as a
	// clean run.
	const TARGET = "extensions/supervisor/lib/shared-prompts.ts";

	it("target file is compiled and produces zero TS6133/TS6192/TS6196 errors", () => {
		let status: number | null = null;
		let output = "";
		try {
			output = execSync(
				"npx tsc --noEmit --noUnusedLocals --noUnusedParameters --listFiles --project .pi/tsconfig.json",
				{
					cwd: resolve(EXT_ROOT, "../../.."),
					encoding: "utf8",
					stdio: "pipe",
					maxBuffer: 64 * 1024 * 1024,
				},
			);
			status = 0;
		} catch (err) {
			const e = err as NodeJS.ErrnoException & {
				status?: number | null;
				stdout?: string;
				stderr?: string;
			};
			output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
			if (typeof e.status !== "number") {
				assert.fail(`tsc could not be launched: ${e.code ?? ""} ${e.message}`);
			}
			status = e.status;
		}

		// Configuration/CLI failures (TS5xxx) mean the project was never compiled.
		const configErrors = output.match(/error TS5\d{3}/g);
		assert.equal(
			configErrors,
			null,
			`tsc configuration failure — project not compiled:\n${configErrors?.join("\n")}`,
		);

		// A non-zero exit with no diagnostics means the compiler did not run.
		assert.ok(
			status === 0 || /error TS\d+/.test(output),
			`tsc exited ${status} without diagnostics — compiler did not run:\n${output}`,
		);

		// Positive control: the target must appear in the compiler's file list.
		assert.ok(
			output.includes(TARGET),
			`compiler did not process ${TARGET} (absent from --listFiles output)`,
		);

		const matches = output.match(
			/lib\/shared-prompts\.ts\(\d+,\d+\): error TS(6133|6192|6196)/g,
		);
		assert.equal(
			matches,
			null,
			`shared-prompts.ts must have no unused-symbol errors, got:\n${matches?.join("\n")}`,
		);
	});
});
