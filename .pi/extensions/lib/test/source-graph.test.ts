// ─── Tests: lib/test/source-graph.ts (issue #1866) ────────────────
// Parsed module-graph test support: readGraph / importersOf /
// declarersOf. Fixtures are synthetic .ts files in a temp dir so the
// parser is exercised without coupling to any real module.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readGraph, importersOf, declarersOf } from "./source-graph.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

let dir: string;

function fixture(name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content, "utf-8");
	return path;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "source-graph-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("readGraph — imports", () => {
	it("captures the module specifier and named bindings of a single-line import", () => {
		const file = fixture(
			"a.ts",
			'import { a, b } from "./x.ts";\n',
		);
		const graph = readGraph(file);
		assert.deepEqual(graph.specifiers, ["./x.ts"]);
		assert.deepEqual(graph.importedNames, ["a", "b"]);
	});

	it("captures default, namespace, aliased and side-effect imports", () => {
		const file = fixture(
			"a.ts",
			[
				'import Def from "./default.ts";',
				'import * as ns from "./ns.ts";',
				'import { orig as alias } from "./alias.ts";',
				'import "./side.ts";',
				'import type { T } from "./types.ts";',
			].join("\n"),
		);
		const graph = readGraph(file);
		assert.deepEqual(graph.specifiers, [
			"./default.ts",
			"./ns.ts",
			"./alias.ts",
			"./types.ts",
			"./side.ts",
		]);
		assert.ok(graph.importedNames.includes("Def"));
		assert.ok(graph.importedNames.includes("ns"));
		assert.ok(graph.importedNames.includes("alias"));
		assert.ok(graph.importedNames.includes("T"));
	});

	it("records the specifier of a multi-line import", () => {
		const file = fixture(
			"a.ts",
			['import {', "\ta,", "\tb,", '} from "./x.ts";', ""].join("\n"),
		);
		const graph = readGraph(file);
		assert.deepEqual(graph.specifiers, ["./x.ts"]);
		assert.deepEqual(graph.importedNames, ["a", "b"]);
	});

	it("parses imports with leading tabs or spaces", () => {
		const file = fixture("a.ts", '\t import { a } from "./tab.ts";\n');
		assert.ok(readGraph(file).specifiers.includes("./tab.ts"));
	});
});

describe("readGraph — re-exports", () => {
	it("starReExports equals the targets of `export * from`", () => {
		const file = fixture(
			"a.ts",
			[
				'export * from "./m.ts";',
				'export * from "./n.ts";',
			].join("\n"),
		);
		assert.deepEqual(readGraph(file).starReExports, ["./m.ts", "./n.ts"]);
	});

	it("namedReExports captures `export { a } from` and bare `export { a }`", () => {
		const file = fixture(
			"a.ts",
			['export { a } from "./x.ts";', "export { b, c as d };", ""].join("\n"),
		);
		const graph = readGraph(file);
		assert.ok(graph.namedReExports.includes("a"));
		assert.ok(graph.namedReExports.includes("b"));
		assert.ok(graph.namedReExports.includes("d"));
		assert.ok(graph.specifiers.includes("./x.ts"));
	});
});

describe("readGraph — declarations", () => {
	it("captures interface/type/function/const/class names", () => {
		const file = fixture(
			"a.ts",
			[
				"export interface DebugLogger { child(): void; }",
				"type Alias = string;",
				"export function build(): void {}",
				"export const VALUE = 1;",
				"class Thing {}",
				"const { destructured } = obj;",
			].join("\n"),
		);
		const declarations = readGraph(file).declarations;
		for (const name of ["DebugLogger", "Alias", "build", "VALUE", "Thing"]) {
			assert.ok(declarations.includes(name), `declarations includes ${name}`);
		}
		assert.ok(!declarations.includes("destructured"), "destructuring is not a declaration");
	});
});

describe("readGraph — comments are stripped", () => {
	it("line and block comments contribute nothing", () => {
		const file = fixture(
			"a.ts",
			[
				'// import { x } from "./y.ts"',
				'/* export * from "./z.ts"',
				"   interface Ghost {} */",
				'import { real } from "./real.ts";',
			].join("\n"),
		);
		const graph = readGraph(file);
		assert.deepEqual(graph.specifiers, ["./real.ts"]);
		assert.deepEqual(graph.starReExports, []);
		assert.deepEqual(graph.namedReExports, []);
		assert.ok(!graph.declarations.includes("Ghost"));
	});
});

describe("importersOf / declarersOf", () => {
	it("returns sorted module basenames importing the specifier", () => {
		fixture("zeta.ts", 'import { spawn } from "node:child_process";\n');
		fixture("alpha.ts", 'import { spawn } from "node:child_process";\n');
		fixture("other.ts", 'import { readFileSync } from "node:fs";\n');
		assert.deepEqual(importersOf(dir, "node:child_process"), ["alpha.ts", "zeta.ts"]);
	});

	it("excludes modules that only mention the specifier in a comment", () => {
		fixture("commented.ts", '// import { spawn } from "node:child_process";\n');
		fixture("real.ts", 'import { spawn } from "node:child_process";\n');
		assert.deepEqual(importersOf(dir, "node:child_process"), ["real.ts"]);
	});

	it("returns [] when nothing imports the specifier", () => {
		fixture("a.ts", 'import { x } from "./x.ts";\n');
		assert.deepEqual(importersOf(dir, "config/diagnostics"), []);
	});

	it("declarersOf returns sorted declaring modules, [] when undeclared", () => {
		fixture("one.ts", "export interface DebugLogger { child(): void; }\n");
		fixture("two.ts", "const DebugLogger = 1;\n");
		fixture("three.ts", 'import type { DebugLogger } from "./one.ts";\n');
		assert.deepEqual(declarersOf(dir, "DebugLogger"), ["one.ts", "two.ts"]);
		assert.deepEqual(declarersOf(dir, "Missing"), []);
	});
});

describe("helper contract", () => {
	it("uses stdlib only — no test-framework import", () => {
		const source = readFileSync(join(__dirname, "./source-graph.ts"), "utf-8");
		assert.ok(!/from\s+["']node:test["']/.test(source), "helper must not import node:test");
	});
});
