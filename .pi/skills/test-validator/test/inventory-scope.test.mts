// Phase 1f — the completion claim is checkable against the tree it describes.
//
// The skill claims "every test this repository runs", not "every file that
// mentions a test". This guard makes that claim falsifiable in two directions:
// any file that could carry tests in a language the inventory does not enumerate
// fails here, and every Rust file that declares a test must actually be
// enumerated by the inventory. The Rust/WASM UI crate is in scope: the UI image
// the PR smoke gate builds runs `cargo test` over it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SKIPPED_DIRS } from "../lib/inventory-file-names.ts";
import { discoverInFile, languageOf } from "../lib/inventory-file.ts";
import { declaresRustTest } from "../lib/inventory-rust.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const SKILL = resolve(HERE, "..");

/** The crate whose `cargo test` run this audit must include. */
const RUST_UI_CRATE = "cmd/cheasee-pi/embedded/docker/ui/";

/** Test-file conventions of languages the inventory has no enumerator for. */
const UNSUPPORTED_TEST_FILE: ReadonlyArray<{ readonly language: string; readonly match: RegExp }> =
	[
		{ language: "ruby", match: /(^|\/)(test_.*|.*_test|.*_spec)\.rb$/ },
		{ language: "java", match: /(^|\/)(Test[A-Z].*|.*Test|.*Tests|.*IT)\.java$/ },
		{ language: "kotlin", match: /(^|\/)(Test[A-Z].*|.*Test|.*Tests)\.kt$/ },
		{ language: "csharp", match: /(^|\/)(Test[A-Z].*|.*Test|.*Tests)\.cs$/ },
		{ language: "php", match: /(^|\/)(Test[A-Z].*|.*Test|.*Tests)\.php$/ },
	];

function walk(dir: string, found: string[]): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIPPED_DIRS.has(entry.name)) continue;
			walk(path, found);
			continue;
		}
		if (entry.isFile()) found.push(relative(ROOT, path).split("\\").join("/"));
	}
	return found;
}

describe("inventory scope: what the audit claims to cover is checkable", () => {
	const files = walk(ROOT, []);
	const rustFiles = files.filter((file) => file.endsWith(".rs"));

	it("finds the tracked tree it is guarding", () => {
		assert.ok(files.length > 100, `walked ${files.length} files from ${ROOT}`);
		assert.ok(rustFiles.length > 0, "the tree contains the Rust UI crate");
	});

	it("only holds tests in languages the inventory cannot enumerate outside a documented exemption", () => {
		const offenders: string[] = [];
		for (const file of files) {
			for (const rule of UNSUPPORTED_TEST_FILE) {
				if (rule.match.test(file)) offenders.push(`${file} (${rule.language})`);
			}
		}
		assert.deepEqual(
			offenders,
			[],
			`a test suite in an un-enumerated language would escape the audit; add its ` +
				`enumerator to lib/inventory-file.ts or document the exemption in SKILL.md: ${offenders.join(", ")}`,
		);
	});

	it("maps every Rust file to the Rust enumerator", () => {
		for (const file of rustFiles) {
			assert.equal(languageOf(file), "rust", `${file} must be enumerable`);
		}
		assert.equal(
			UNSUPPORTED_TEST_FILE.some((rule) => rule.language === "rust"),
			false,
		);
	});

	it("enumerates every Rust file that declares a test, including the UI crate", () => {
		let crateTests = 0;
		let crateFiles = 0;
		for (const file of rustFiles) {
			const source = readFileSync(join(ROOT, file), "utf8");
			if (!declaresRustTest(source)) continue;
			const result = discoverInFile(source, file);
			assert.ok(result.tests.length > 0, `${file} declares a test attribute but yields none`);
			for (const def of result.tests) {
				assert.equal(def.language, "rust");
				assert.ok(def.endLine >= def.startLine);
				assert.equal(def.file, file);
			}
			if (file.startsWith(RUST_UI_CRATE)) {
				crateFiles += 1;
				crateTests += result.tests.length;
			}
		}
		assert.ok(crateTests > 100, `the UI crate's cargo tests are inventoried, got ${crateTests}`);
		assert.ok(crateFiles > 10, `the UI crate's test files are inventoried, got ${crateFiles}`);
	});

	it("states the enumeration rule in SKILL.md, next to the discovery table", () => {
		const skill = readFileSync(resolve(SKILL, "SKILL.md"), "utf8");
		assert.match(skill, /\|\s*Rust\s*\|/);
		assert.match(skill, /cargo test/);
		assert.ok(skill.includes(RUST_UI_CRATE), "SKILL.md names the crate it audits");
		assert.match(skill, /\*\*What is not audited\.\*\*/);
	});
});
