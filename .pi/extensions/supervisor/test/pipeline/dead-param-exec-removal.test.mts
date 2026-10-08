/**
 * dead-param-exec-removal.test.mts — issue #1854
 *
 * Interface-shrinking refactor in pipeline/helpers.ts:
 *   - `readProjectBoard` / `checkDependencies` no longer name `exec: ExecFn`
 *   - `port` is required, parameters reordered `port` before `collector?`
 *   - `readProjectBoard`'s dead `_issueNum` param removed
 *   - `throw new Error("GitHubPort not provided …")` guards deleted
 *
 * Source-absence contract, plus an over-deletion guard so the four
 * pass-through functions that DO use the subprocess seam stay intact.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline/dead-param-exec-removal.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..", "..");

function readSource(relativePath: string): string {
	return readFileSync(resolve(EXT_ROOT, relativePath), "utf8");
}

/** Slice the parameter list of an exported async function from source. */
function paramBlock(source: string, fnName: string): string {
	const m = source.match(new RegExp(`export async function ${fnName}\\(([\\s\\S]*?)\\): Promise`));
	assert.ok(m, `parameter block for ${fnName} not found`);
	return m![1];
}

describe("helpers.ts — dead exec parameter removed (source absence)", () => {
	const source = readSource("pipeline/helpers.ts");

	it("readProjectBoard no longer names exec / _issueNum, port is required", () => {
		const block = paramBlock(source, "readProjectBoard");
		assert.equal(block.includes("exec: ExecFn"), false, "readProjectBoard must not name exec");
		assert.equal(block.includes("_issueNum"), false, "_issueNum must be removed");
		assert.equal(block.includes("issueNum"), false, "readProjectBoard must not take issueNum");
		assert.ok(block.includes("port: GitHubPort"), "port must be required GitHubPort");
		assert.equal(block.includes("port?:"), false, "port must not be optional");
	});

	it("checkDependencies no longer names exec, port is required, issueNum kept", () => {
		const block = paramBlock(source, "checkDependencies");
		assert.equal(block.includes("exec: ExecFn"), false, "checkDependencies must not name exec");
		assert.ok(block.includes("issueNum: number"), "checkDependencies keeps issueNum");
		assert.ok(block.includes("port: GitHubPort"), "port must be required GitHubPort");
		assert.equal(block.includes("port?:"), false, "port must not be optional");
	});

	it("port precedes collector? in both signatures (TS1016 constraint)", () => {
		for (const fn of ["readProjectBoard", "checkDependencies"]) {
			const block = paramBlock(source, fn);
			const portIdx = block.indexOf("port: GitHubPort");
			const collectorIdx = block.indexOf("collector?");
			assert.ok(portIdx >= 0, `${fn} must name port`);
			assert.ok(collectorIdx >= 0, `${fn} must name collector?`);
			assert.ok(portIdx < collectorIdx, `${fn}: port must come before collector?`);
		}
	});

	it("GitHubPort-not-provided throw guards are deleted", () => {
		assert.equal(source.includes("GitHubPort not provided"), false);
	});
});

describe("over-deletion guard — pass-through seams preserved", () => {
	it("helpers.ts keeps exec in the functions that call it", () => {
		const source = readSource("pipeline/helpers.ts");
		for (const fn of ["fetchIssue", "fetchFreshIssueData", "loadAgentFile"]) {
			assert.ok(
				paramBlock(source, fn).includes("exec: ExecFn"),
				`${fn} must keep exec: ExecFn`,
			);
		}
	});

	it("the four false positives still name exec/execFn", () => {
		assert.ok(readSource("github/comment.ts").includes("exec"));
		assert.ok(readSource("checks/requirements/index.ts").includes("exec"));
		assert.ok(readSource("pipeline/stages/empty-worktree.ts").includes("execFn"));
		assert.ok(readSource("pipeline/stages/git-ops.ts").includes("execFn"));
	});
});
