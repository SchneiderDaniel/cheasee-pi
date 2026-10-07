/**
 * dead-code-core-unused-removal.test.mts — issue #1868
 *
 * Dead-code deletion in pipeline/stages/core.ts:
 *   - 7 unused import bindings
 *   - module-private `BareTextRule` type + `BARE_TEXT_RULES` table (stale
 *     duplicate of the live copy in pipeline/stages/agent-comment.ts)
 *
 * No static import of the removed symbols — verification is by source
 * read (absence) plus dynamic `import()` of the surviving barrel contract.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code-core-unused-removal.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");

function readSource(relativePath: string): string {
	return readFileSync(resolve(EXT_ROOT, relativePath), "utf8");
}

describe("core.ts — dead symbols deleted (source absence)", () => {
	const source = readSource("pipeline/stages/core.ts");

	it("BARE_TEXT_RULES / BareTextRule are gone", () => {
		assert.equal(source.includes("BARE_TEXT_RULES"), false);
		assert.equal(source.includes("BareTextRule"), false);
	});

	it("all 8 unused import specifiers are gone", () => {
		for (const spec of [
			"ExtensionAPI",
			"ExtensionCommandContext",
			"FilteredIssueData",
			"ErrorCollector",
			"NotifyFn",
			"commitAndPush",
			"extractAgentCommentBody",
			"extractStructuredAuditOutput",
		]) {
			assert.equal(source.includes(spec), false, `${spec} must be removed`);
		}
	});
});

describe("core.ts — live bindings preserved (over-deletion guard)", () => {
	const source = readSource("pipeline/stages/core.ts");

	it("surviving config/types specifiers remain", () => {
		for (const spec of [
			"SupervisorConfig",
			"ProjectField",
			"PipelineAgentResult",
			"AgentRunResult",
		]) {
			assert.equal(source.includes(spec), true, `${spec} must be kept`);
		}
	});

	it("surviving agent/output specifiers remain", () => {
		for (const spec of [
			"parseAgentOutput",
			"isSuccess as isAgentOutputSuccess",
			"isRefused as isAgentOutputRefused",
		]) {
			assert.equal(source.includes(spec), true, `${spec} must be kept`);
		}
	});

	it("MAX_PIPELINE_LOOPS is still exported and === 20", async () => {
		const mod = await import("../pipeline/stages/core.ts");
		assert.equal(mod.MAX_PIPELINE_LOOPS, 20);
	});
});

describe("agent-comment.ts — canonical bare-text table intact", () => {
	const source = readSource("pipeline/stages/agent-comment.ts");

	it("defines BareTextRule and BARE_TEXT_RULES", () => {
		assert.equal(source.includes("type BareTextRule"), true);
		assert.equal(source.includes("const BARE_TEXT_RULES"), true);
	});

	it("BARE_TEXT_RULES is consumed", () => {
		assert.match(source, /BARE_TEXT_RULES\.find\(/);
	});
});

describe("stages barrel — public contract intact", () => {
	it("runtime exports are functions or numbers (no dropped binding)", async () => {
		const barrel = await import("../pipeline/stages/index.ts");
		const runtimeKeys = Object.keys(barrel).filter(
			(k) => k !== "default" && typeof (barrel as Record<string, unknown>)[k] !== "undefined",
		);
		assert.ok(runtimeKeys.length >= 20, `expected >=20 runtime exports, got ${runtimeKeys.length}`);
		for (const key of runtimeKeys) {
			const value = (barrel as Record<string, unknown>)[key];
			if (typeof value === "function" || typeof value === "number") continue;
			// re-exported value exports may be objects/functions; anything else is a surprise
			assert.ok(
				typeof value === "object",
				`unexpected export type for ${key}: ${typeof value}`,
			);
		}
	});
});

describe("tsc gate — core.ts clean under --noUnusedLocals", () => {
	it("core.ts produces zero TS6133/TS6192/TS6196 errors", () => {
		let output = "";
		try {
			output = execSync(
				"npx tsc --noEmit --noUnusedLocals --noUnusedParameters --project .pi/tsconfig.json",
				{ cwd: resolve(EXT_ROOT, "../../.."), encoding: "utf8", stdio: "pipe" },
			);
		} catch (err) {
			const e = err as { stdout?: string; stderr?: string };
			output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
		}
		const matches = output.match(/pipeline\/stages\/core\.ts\(\d+,\d+\): error TS(6133|6192|6196)/g);
		assert.equal(matches, null, `core.ts must have no unused-symbol errors, got:\n${matches?.join("\n")}`);
	});
});
