/**
 * Tests: structural_search `directory` containment guard (CWE-22)
 *
 * The `directory` param used to be handed to ast-grep raw: absolute paths and
 * `..`-relative paths resolved outside the project root and were scanned as-is.
 * These tests pin the fail-closed guard: out-of-root directories throw before
 * any cache lookup and before any ast-grep `run` exec, and the raw (unresolved)
 * value is quoted in the error.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/structural-analyzer/test/directory-traversal.test.mts
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import structuralAnalyzer from "../index.ts";
import { clearResultCache, getCache, makeCacheKey, setCache } from "../cache.ts";
import type { ExecResultResponse } from "../types.ts";

const CWD = mkdtempSync(join(tmpdir(), "sa-traversal-"));
after(() => rmSync(CWD, { recursive: true, force: true }));

const PATTERN = "console.log($A)";

/** Directories that must never be scanned. */
const ESCAPES = [
	"/etc",
	"../../etc",
	"..",
	"../../../../tmp",
	"subdir/../../../../etc",
	"/",
	`../${basename(CWD)}-evil`,
];

function makePi(execOverride?: (cmd: string, args: string[], options?: any) => Promise<any>): any {
	let registeredTool: any = null;
	const calls: Array<{ cmd: string; args: string[]; options?: any }> = [];

	const pi = {
		registerTool: (tool: any) => {
			registeredTool = tool;
		},
		on: () => {},
		exec: async (cmd: string, args: string[], options?: any) => {
			calls.push({ cmd, args, options });
			if (execOverride) return execOverride(cmd, args, options);
			if (args.includes("--version"))
				return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};

	(pi as any).__getRegisteredTool = () => registeredTool;
	(pi as any).__getCalls = () => calls;
	return pi;
}

async function executeTool(pi: any, params: Record<string, unknown>): Promise<any> {
	const tool = pi.__getRegisteredTool();
	if (!tool) throw new Error("No tool registered");
	return tool.execute("test-call-id", params, undefined, undefined, { cwd: CWD });
}

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
	try {
		await fn();
	} catch (err) {
		return err as Error;
	}
	throw new Error("expected execute() to reject, but it resolved");
}

const FAKE_RESPONSE: ExecResultResponse = {
	content: [{ type: "text", text: "poisoned" }],
	details: { success: true, matches: 0, results: [] },
};

describe("structural_search directory containment guard", () => {
	beforeEach(() => {
		clearResultCache();
	});

	for (const escape of ESCAPES) {
		it(`rejects out-of-root directory "${escape}"`, async () => {
			const pi = makePi();
			structuralAnalyzer(pi);

			const err = await captureError(() =>
				executeTool(pi, { pattern: PATTERN, language: "ts", directory: escape }),
			);

			assert.match(err.message, /Directory traversal detected/);
			assert.ok(
				err.message.includes(`"${escape}"`),
				`error must quote the raw directory "${escape}", got: ${err.message}`,
			);
		});

		it(`does not invoke an ast-grep run for out-of-root directory "${escape}"`, async () => {
			const pi = makePi();
			structuralAnalyzer(pi);

			await captureError(() =>
				executeTool(pi, { pattern: PATTERN, language: "ts", directory: escape }),
			);

			const scans = pi.__getCalls().filter((c: any) => c.args[0] === "run");
			assert.equal(scans.length, 0, "scan must never run for an out-of-root directory");
		});
	}

	it("guard fires before the cache lookup (poisoned raw-key entry not served)", async () => {
		const pi = makePi();
		structuralAnalyzer(pi);

		// Attacker-controlled / stale raw key exactly as the old code built it
		const poisonedKey = makeCacheKey(PATTERN, "ts", "../../etc");
		setCache(poisonedKey, FAKE_RESPONSE);

		const err = await captureError(() =>
			executeTool(pi, { pattern: PATTERN, language: "ts", directory: "../../etc" }),
		);
		assert.match(err.message, /Directory traversal detected/);
		assert.equal(getCache(poisonedKey), FAKE_RESPONSE, "test premise: entry still present");
	});

	it("guard blocks a cache entry keyed by the resolved out-of-root path", async () => {
		const pi = makePi();
		structuralAnalyzer(pi);

		const poisonedKey = makeCacheKey(PATTERN, "ts", resolve(CWD, "../../etc"));
		setCache(poisonedKey, FAKE_RESPONSE);

		const err = await captureError(() =>
			executeTool(pi, { pattern: PATTERN, language: "ts", directory: "../../etc" }),
		);
		assert.match(err.message, /Directory traversal detected/);
	});

	it("allows an absolute path equal to ctx.cwd", async () => {
		const pi = makePi();
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: PATTERN, language: "ts", directory: CWD });
		assert.ok(result, "in-root absolute directory should be allowed");
	});

	it("allows a relative in-root child and passes the resolved dir to ast-grep", async () => {
		const pi = makePi();
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: PATTERN, language: "ts", directory: "sub" });

		const scan = pi.__getCalls().find((c: any) => c.args[0] === "run");
		assert.ok(scan, "scan should have run");
		assert.ok(
			scan.args.includes(resolve(CWD, "sub")),
			`args should carry the resolved dir, got: ${JSON.stringify(scan.args)}`,
		);
		assert.ok(!scan.args.includes("sub"), "raw relative dir must not be passed through");
	});

	it("treats an empty directory as falsy: no guard, no path operand", async () => {
		const pi = makePi();
		structuralAnalyzer(pi);

		const result = await executeTool(pi, { pattern: PATTERN, language: "ts", directory: "" });
		assert.ok(result);

		const scan = pi.__getCalls().find((c: any) => c.args[0] === "run");
		assert.ok(scan, "scan should have run");
		assert.equal(scan.args.at(-1), "--no-ignore=hidden", "no path operand for empty directory");
	});

	it("omitted directory still scans ctx.cwd with no path operand", async () => {
		const pi = makePi();
		structuralAnalyzer(pi);

		await executeTool(pi, { pattern: PATTERN, language: "ts" });

		const scan = pi.__getCalls().find((c: any) => c.args[0] === "run");
		assert.ok(scan, "scan should have run");
		assert.equal(scan.args.at(-1), "--no-ignore=hidden", "no path operand when omitted");
	});

	it("pattern validation still wins over a traversal directory", async () => {
		const pi = makePi();
		structuralAnalyzer(pi);

		const err = await captureError(() =>
			executeTool(pi, { pattern: "TODO", language: "ts", directory: "../../etc" }),
		);
		assert.doesNotMatch(err.message, /Directory traversal detected/);
	});
});
