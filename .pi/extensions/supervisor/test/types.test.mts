/**
 * Tests for the canonical subprocess-exec contract (issue #1853).
 *
 * ExecFn/ExecResult have exactly one home — lib/port-types.ts. This file
 * scans production source (pipeline/, github/, checks/) to prove no local
 * re-declaration survives and that github/ no longer imports exec types
 * from the sibling pipeline/ tree. Source-scan only, no runtime behaviour.
 *
 * Layer: (D) Domain — source scanning, filesystem reads only.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, "../.."); // .pi/extensions

const readExt = (rel: string): string => readFileSync(resolve(extDir, rel), "utf-8");

/** Recursively collect *.ts files under a directory (relative to extDir). */
function collectTs(relDir: string): string[] {
	const out: string[] = [];
	const walk = (rel: string): void => {
		for (const entry of readdirSync(resolve(extDir, rel), { withFileTypes: true })) {
			const child = `${rel}/${entry.name}`;
			if (entry.isDirectory()) walk(child);
			else if (entry.name.endsWith(".ts")) out.push(child);
		}
	};
	walk(relDir);
	return out;
}

const importsExecFrom = (source: string, specifier: string): boolean =>
	new RegExp(
		`import\\s+type\\s*\\{[^}]*\\bExecFn\\b[^}]*\\}\\s*from\\s+["']${specifier.replace(/\./g, "\\.")}["']`,
	).test(source);

// ── Phase 1: one canonical contract in lib/port-types.ts ──

describe("lib/port-types.ts — canonical ExecFn/ExecResult", () => {
	const src = readExt("lib/port-types.ts");

	it("(entity) exports ExecFn returning Promise<ExecResult>", () => {
		assert.ok(/export\s+type\s+ExecFn\s*=\s*\(/.test(src), "must export type ExecFn = (");
		assert.ok(src.includes("Promise<ExecResult>"), "ExecFn must return Promise<ExecResult>");
	});

	it("(entity) ExecResult has exactly code/stdout/stderr — no killed/signal", () => {
		assert.ok(/export\s+type\s+ExecResult\s*=\s*\{/.test(src), "must export type ExecResult = {");
		assert.ok(/^\s*code:\s*number;/m.test(src), "ExecResult needs code: number");
		assert.ok(/^\s*stdout:\s*string;/m.test(src), "ExecResult needs stdout: string");
		assert.ok(/^\s*stderr:\s*string;/m.test(src), "ExecResult needs stderr: string");
		assert.ok(!/^\s*killed\??\s*:/m.test(src), "canonical ExecResult must not carry killed");
		assert.ok(!/^\s*signal\??\s*:/m.test(src), "canonical ExecResult must not carry signal");
	});
});

describe("pipeline/helpers.ts — no local ExecFn, imports canonical", () => {
	const src = readExt("supervisor/pipeline/helpers.ts");

	it("(entity) contains no `type ExecFn =` declaration", () => {
		assert.ok(!/type\s+ExecFn\s*=/.test(src), "helpers.ts must not re-declare ExecFn");
	});

	it("(entity) no stale ExecOptions/ExecResult imports from pi-coding-agent", () => {
		assert.ok(
			!/import[^;]*\b(?:ExecOptions|ExecResult)\b[^;]*@earendil-works\/pi-coding-agent/.test(src),
			"stale upstream exec imports must be removed",
		);
	});

	it("(entity) still exports NotifyFn", () => {
		assert.ok(/export\s+interface\s+NotifyFn/.test(src), "NotifyFn stays in helpers.ts");
	});

	it("(entity) imports ExecFn from ../../lib/port-types.ts", () => {
		assert.ok(
			importsExecFrom(src, "../../lib/port-types.ts"),
			"helpers.ts must import ExecFn from lib/port-types.ts",
		);
	});
});

// ── Phase 2: production importers re-point to canonical ──

const PROD_IMPORTERS: Array<[string, string]> = [
	["supervisor/github/git.ts", "../../lib/port-types.ts"],
	["supervisor/github/comment.ts", "../../lib/port-types.ts"],
	["supervisor/github/gh-client.ts", "../../lib/port-types.ts"],
	["supervisor/pipeline/handler/preflight.ts", "../../../lib/port-types.ts"],
	["supervisor/pipeline/handler/shared.ts", "../../../lib/port-types.ts"],
	["supervisor/pipeline/audit/index.ts", "../../../lib/port-types.ts"],
	["supervisor/pipeline/audit/pre-gates.ts", "../../../lib/port-types.ts"],
	["supervisor/pipeline/stages/empty-worktree.ts", "../../../lib/port-types.ts"],
];

describe("production importers — ExecFn comes from lib/port-types.ts", () => {
	for (const [file, specifier] of PROD_IMPORTERS) {
		it(`(entity) ${file} imports ExecFn from ${specifier}`, () => {
			const src = readExt(file);
			assert.ok(importsExecFrom(src, specifier), `${file} must import ExecFn from ${specifier}`);
			assert.ok(
				!importsExecFrom(src, "../helpers.ts") &&
					!importsExecFrom(src, "../pipeline/helpers.ts"),
				`${file} must not import ExecFn from helpers`,
			);
		});
	}

	it("(entity) handler/preflight.ts + shared.ts keep NotifyFn from helpers.ts", () => {
		for (const file of [
			"supervisor/pipeline/handler/preflight.ts",
			"supervisor/pipeline/handler/shared.ts",
		]) {
			assert.ok(
				/\bNotifyFn\b[^}]*\}\s*from\s+["']\.\.\/helpers\.ts["']/.test(readExt(file)),
				`${file} must keep importing NotifyFn from ../helpers.ts`,
			);
		}
	});

	it("(entity) gh-client.ts ExecResult points at lib/port-types.ts", () => {
		const src = readExt("supervisor/github/gh-client.ts");
		assert.ok(
			/import\s+type\s*\{[^}]*\bExecResult\b[^}]*\}\s*from\s+["']\.\.\/\.\.\/lib\/port-types\.ts["']/.test(
				src,
			),
			"gh-client.ts ExecResult must come from lib/port-types.ts",
		);
		assert.ok(
			!/import[^;]*\bExecResult\b[^;]*@earendil-works\/pi-coding-agent/.test(src),
			"gh-client.ts must not import ExecResult from pi-coding-agent",
		);
	});
});

// ── Phase 3: test importers re-point ──

const TEST_IMPORTERS: Array<[string, string]> = [
	["supervisor/test/pipeline/helpers.test.mts", "../../../lib/port-types.ts"],
	["supervisor/test/pipeline/empty-worktree-dispatch.test.mts", "../../../lib/port-types.ts"],
	["supervisor/test/supervisor-github-helpers.test.mts", "../../lib/port-types.ts"],
	["supervisor/test/github/comment.test.mts", "../../../lib/port-types.ts"],
	["supervisor/test/github/git.test.mts", "../../../lib/port-types.ts"],
	["supervisor/test/github/gh-client.test.mts", "../../../lib/port-types.ts"],
	["supervisor/test/pre-gates.test.mts", "../../lib/port-types.ts"],
];

describe("test importers — ExecFn comes from lib/port-types.ts", () => {
	for (const [file, specifier] of TEST_IMPORTERS) {
		it(`(entity) ${file} imports ExecFn from ${specifier}`, () => {
			assert.ok(
				importsExecFrom(readExt(file), specifier),
				`${file} must import ExecFn from ${specifier}`,
			);
		});
	}
});

// ── Phase 4: seam + divergence boundaries ──

describe("seam — no exec type crosses github/ → pipeline/", () => {
	it("(entity) no github/ file imports ExecFn or ExecResult from ../pipeline/", () => {
		for (const file of collectTs("supervisor/github")) {
			const src = readExt(file);
			assert.ok(
				!/import\s+type\s*\{[^}]*\b(?:ExecFn|ExecResult)\b[^}]*\}\s*from\s+["']\.\.\/pipeline\//.test(
					src,
				),
				`${file} must not import exec types from ../pipeline/`,
			);
		}
	});

	it("(entity) checks/shared.ts re-export pattern is untouched", () => {
		const src = readExt("supervisor/checks/shared.ts");
		assert.ok(
			/import\s+type\s*\{[^}]*\bExecFn\b[^}]*\}\s*from\s+["']\.\.\/\.\.\/lib\/port-types\.ts["']/.test(
				src,
			),
			"checks/shared.ts must import ExecFn from lib/port-types.ts",
		);
		assert.ok(/export\s+type\s*\{\s*ExecFn\s*\}/.test(src), "checks/shared.ts must re-export ExecFn");
	});

	it("(entity) web-search/types.ts re-export unchanged", () => {
		const src = readExt("web-search/types.ts");
		assert.ok(
			/export\s+type\s*\{[^}]*\bExecFn\b[^}]*\}\s*from\s+["']\.\.\/lib\/port-types\.ts["']/.test(src),
			"web-search/types.ts must re-export ExecFn from lib/port-types.ts",
		);
	});

	it("(entity) scrapling divergent interface ExecFn preserved", () => {
		const src = readExt("scrapling/types.ts");
		assert.ok(/export\s+interface\s+ExecFn/.test(src), "scrapling keeps its divergent interface");
		assert.ok(/Diverges from lib\/port-types/.test(src), "divergence comment must survive");
	});

	it("(entity) zero local ExecFn declarations across pipeline|github|checks prod source", () => {
		for (const dir of ["supervisor/pipeline", "supervisor/github", "supervisor/checks"]) {
			for (const file of collectTs(dir)) {
				const src = readExt(file);
				assert.ok(
					!/type\s+ExecFn\s*=/.test(src) && !/interface\s+ExecFn\s*\{/.test(src),
					`${file} must not declare a local ExecFn`,
				);
			}
		}
	});

	it("(entity) lib/port-types.ts is the sole ExecFn declaration in the supervisor tree", () => {
		const decls = collectTs("supervisor").filter(
			(f) => !f.includes("/test/") && /type\s+ExecFn\s*=/.test(readExt(f)),
		);
		assert.deepEqual(decls, [], "no supervisor production source file may declare ExecFn");
		assert.ok(
			/type\s+ExecFn\s*=/.test(readExt("lib/port-types.ts")),
			"lib/port-types.ts owns the ExecFn declaration",
		);
	});
});
