/**
 * Dead-export guard for `checks/file-classification.ts` (split out of
 * dead-code-file-classification-removal.test.mts, issue #2102).
 *
 * The TS-AST analyzer this suite drives is test-only support and lives in
 * `test/support/export-surface.mts` — not named `*.test.mts`, so `node --test`
 * never loads it as a suite, and the `.mts` extension keeps it out of the
 * scored `CODE_EXTS` metric set. Production code can never import it.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/dead-code-file-classification-export-guard.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	collectSourceFiles,
	unreferencedExports,
	type Consumer,
} from "./support/export-surface.mts";

const testDir = dirname(fileURLToPath(import.meta.url));
const supervisorDir = join(testDir, "..");
const checksDir = join(supervisorDir, "checks");
const classificationPath = join(checksDir, "file-classification.ts");

// ═══════════════════════════════════════════════════════════════════════
// collectSourceFiles — the consumer inventory
// ═══════════════════════════════════════════════════════════════════════

describe("collectSourceFiles", () => {
	it("returns only .ts/.mts files outside test/ and node_modules/, all absolute", () => {
		const files = collectSourceFiles(checksDir);
		assert.ok(files.length > 0, "checks/ must contain source files");
		for (const file of files) {
			assert.ok(isAbsolute(file), `${file} must be absolute`);
			assert.ok(file.endsWith(".ts") || file.endsWith(".mts"), `${file} must be a source file`);
			assert.equal(
				file.split(sep).includes("test"),
				false,
				`${file} must not live under a test/ directory`,
			);
			assert.equal(file.includes("node_modules"), false, `${file} must not be vendored`);
		}
	});

	it("walks nested directories but skips test/, node_modules/ and non-source files", () => {
		const root = mkdtempSync(join(tmpdir(), "export-surface-"));
		try {
			mkdirSync(join(root, "nested"), { recursive: true });
			mkdirSync(join(root, "test"), { recursive: true });
			mkdirSync(join(root, "node_modules"), { recursive: true });
			mkdirSync(join(root, "nested", "test"), { recursive: true });
			for (const rel of [
				"a.ts",
				"b.mts",
				"c.json",
				"d.md",
				join("nested", "e.ts"),
				join("test", "f.ts"),
				join("node_modules", "g.ts"),
				join("nested", "test", "h.mts"),
			]) {
				writeFileSync(join(root, rel), "export const x = 1;\n");
			}

			assert.deepEqual(collectSourceFiles(root).sort(), [
				join(root, "a.ts"),
				join(root, "b.mts"),
				join(root, "nested", "e.ts"),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// unreferencedExports — explicit target, no hidden default
// ═══════════════════════════════════════════════════════════════════════

describe("unreferencedExports target handling", () => {
	const synthetic = "export function phantomThing(): void {}\n";
	const consumer = (path: string, source: string): Consumer => ({ path, source });

	it("counts an import that resolves to the explicit target", () => {
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "a.ts"), 'import { phantomThing } from "./_probe.ts";\n')],
				join(checksDir, "_probe.ts"),
			),
			[],
		);
	});

	it("has no implicit default target", () => {
		const implicit = (
			unreferencedExports as unknown as (source: string, consumers: Consumer[]) => string[]
		)(synthetic, [
			consumer(
				join(checksDir, "a.ts"),
				'import { phantomThing } from "./file-classification.ts";\n',
			),
		]);
		assert.deepEqual(implicit, ["phantomThing"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Dead-export guard: every export needs a consumer outside its own file
// ═══════════════════════════════════════════════════════════════════════

describe("file-classification export surface", () => {
	const consumers = (): Consumer[] =>
		collectSourceFiles(checksDir)
			.filter((f) => f !== classificationPath)
			.map((f): Consumer => ({ path: f, source: readFileSync(f, "utf8") }));

	const consumer = (path: string, source: string): Consumer => ({ path, source });
	const synthetic = "export function phantomThing(): void {}\n";

	it("every export has a consumer outside the defining file", () => {
		const unreferenced = unreferencedExports(
			readFileSync(classificationPath, "utf8"),
			consumers(),
			classificationPath,
		);
		assert.deepEqual(unreferenced, [], `unreferenced export(s): ${unreferenced.join(", ")}`);
	});

	it("has teeth: an injected orphan export is reported", () => {
		const source =
			readFileSync(classificationPath, "utf8") + "\nexport function orphanProbe(): void {}\n";
		assert.deepEqual(unreferencedExports(source, consumers(), classificationPath), ["orphanProbe"]);
	});

	it("reports a synthetic export with no consumer as unreferenced", () => {
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "a.ts"), "import { other } from './x.ts';\n")],
				classificationPath,
			),
			["phantomThing"],
		);
	});

	it("does not count a comment-only mention as a consumer", () => {
		const commentOnly = '/* import { phantomThing } from "../file-classification.ts"; */\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "requirements", "x.ts"), commentOnly)],
				classificationPath,
			),
			["phantomThing"],
		);
	});

	it("does not count a similarly named module as a consumer", () => {
		const neighbour = 'import { phantomThing } from "./file-classification-helpers.ts";\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "a.ts"), neighbour)],
				classificationPath,
			),
			["phantomThing"],
		);
	});

	it("does not count a specifier that resolves to a different file", () => {
		// From checks/requirements/, "./file-classification.ts" is a different module.
		const sibling = 'import { phantomThing } from "./file-classification.ts";\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "requirements", "x.ts"), sibling)],
				classificationPath,
			),
			["phantomThing"],
		);
	});

	it("counts an aliased import as a consumer of the imported name", () => {
		const aliased = 'import { phantomThing as classify } from "../file-classification.ts";\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "requirements", "parity.ts"), aliased)],
				classificationPath,
			),
			[],
		);
	});

	it("recognizes re-export clauses and default declarations as exports", () => {
		assert.deepEqual(unreferencedExports("export { phantomThing };\n", [], classificationPath), [
			"phantomThing",
		]);
		assert.deepEqual(
			unreferencedExports(
				"export default function phantomThing(): void {}\n",
				[],
				classificationPath,
			),
			["default"],
		);
	});

	it("recognizes a namespace export as an export", () => {
		assert.deepEqual(
			unreferencedExports('export * as phantomThing from "./x.ts";\n', [], classificationPath),
			["phantomThing"],
		);
	});

	it("fails closed on an unsupported star export in the defining module", () => {
		assert.throws(
			() => unreferencedExports('export * from "./x.ts";\n', [], classificationPath),
			/star re-export/,
		);
	});

	it("counts a default import as a consumer of the default export", () => {
		const defaultSource = "export default function phantomThing(): void {}\n";
		const importer = 'import phantomThing from "../file-classification.ts";\n';
		assert.deepEqual(
			unreferencedExports(
				defaultSource,
				[consumer(join(checksDir, "requirements", "parity.ts"), importer)],
				classificationPath,
			),
			[],
		);
	});

	it("counts a namespace import's member access as a consumer", () => {
		const importer =
			'import * as fc from "./file-classification.ts";\nconst ok = fc.phantomThing;\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "a.ts"), importer)],
				classificationPath,
			),
			[],
		);
	});

	it("counts a computed namespace member access as a consumer", () => {
		const importer =
			'import * as fc from "./file-classification.ts";\nconst ok = fc["phantomThing"];\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "a.ts"), importer)],
				classificationPath,
			),
			[],
		);
	});

	it("counts a destructured namespace import member as a consumer", () => {
		const importer =
			'import * as fc from "./file-classification.ts";\nconst { phantomThing } = fc;\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "a.ts"), importer)],
				classificationPath,
			),
			[],
		);
	});

	it("counts a renamed destructured namespace member as a consumer", () => {
		const importer =
			'import * as fc from "./file-classification.ts";\nconst { phantomThing: renamed } = fc;\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "a.ts"), importer)],
				classificationPath,
			),
			[],
		);
	});

	it("ignores a destructuring whose namespace binding is shadowed", () => {
		const importer =
			'import * as fc from "./file-classification.ts";\nfunction g(fc: any) { const { phantomThing } = fc; }\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "a.ts"), importer)],
				classificationPath,
			),
			["phantomThing"],
		);
	});

	it("ignores a namespace member access shadowed by a local parameter", () => {
		const importer =
			'import * as fc from "./file-classification.ts";\nfunction g(fc: any) { return fc.phantomThing; }\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "a.ts"), importer)],
				classificationPath,
			),
			["phantomThing"],
		);
	});

	it("counts an unshadowed access even alongside a shadowing parameter", () => {
		const importer =
			'import * as fc from "./file-classification.ts";\nconst ok = fc.phantomThing;\nfunction g(fc: any) { return fc.other; }\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "a.ts"), importer)],
				classificationPath,
			),
			[],
		);
	});

	it("recognizes destructured exported bindings as exports", () => {
		assert.deepEqual(
			unreferencedExports("export const { phantomThing } = value;\n", [], classificationPath),
			["phantomThing"],
		);
		assert.deepEqual(
			unreferencedExports("export const [phantomThing] = list;\n", [], classificationPath),
			["phantomThing"],
		);
	});

	it("counts a star re-export as a consumer", () => {
		const importer = 'export * from "./file-classification.ts";\n';
		assert.deepEqual(
			unreferencedExports(
				synthetic,
				[consumer(join(checksDir, "a.ts"), importer)],
				classificationPath,
			),
			[],
		);
	});

	it("excludes the defining file so isTestableFile cannot self-satisfy", () => {
		const source = readFileSync(classificationPath, "utf8");
		assert.ok(unreferencedExports(source, [], classificationPath).includes("isTestableFile"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Split integrity — the analyzer is test support, not production code
// ═══════════════════════════════════════════════════════════════════════

describe("export-surface split integrity", () => {
	const read = (path: string): string => readFileSync(path, "utf8");
	const supportPath = join(testDir, "support", "export-surface.mts");
	const removalPath = join(testDir, "dead-code-file-classification-removal.test.mts");

	it("this guard imports the analyzer from test support", () => {
		const source = read(fileURLToPath(import.meta.url));
		assert.ok(source.includes('from "./support/export-surface.mts"'));
	});

	it("the removal suite no longer carries the analyzer", () => {
		const source = read(removalPath);
		for (const symbol of ["unreferencedExports", "namespaceMembers", "importedNames"]) {
			assert.equal(
				new RegExp(`function\\s+${symbol}\\s*\\(`).test(source),
				false,
				`${symbol} must live only in test support`,
			);
		}
		assert.ok(source.includes("file-classification dead-code removal"), "removal suite must stay");
		assert.ok(source.includes("retained isTestableFile contract"), "contract suite must stay");
	});

	it("the support module is .mts, not a suite, and registers no tests", () => {
		assert.ok(supportPath.endsWith(".mts"));
		assert.equal(supportPath.endsWith(".test.mts"), false);
		const source = read(supportPath);
		assert.equal(
			/from\s+["']node:test["']/.test(source),
			false,
			"support must not import node:test",
		);
		assert.equal(/(^|\s)(describe|it)\s*\(/.test(source), false, "support must register no tests");
	});

	it("no production module under supervisor/ imports the test-only analyzer", () => {
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "test" || entry.name === "node_modules") continue;
					walk(full);
				} else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mts"))) {
					if (readFileSync(full, "utf8").includes("export-surface")) offenders.push(full);
				}
			}
		};
		walk(supervisorDir);
		assert.deepEqual(offenders, [], "test-only support must not be imported by production code");
	});
});
