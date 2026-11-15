// Phase 1d — the completion claim is checkable against the tree it describes.
//
// The skill claims "every test this repository runs", not "every file that
// mentions a test". This guard makes that claim falsifiable: any file that could
// carry tests in a language the inventory does not enumerate must live in the one
// documented exception (the Rust/WASM UI crate, which no CI job or documented
// command compiles), so adding a suite in a new language fails here instead of
// silently escaping the audit.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SKIPPED_DIRS } from "../lib/inventory-file-names.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const SKILL = resolve(HERE, "..");

/** The one documented exemption: Rust, which no runner in this repo invokes. */
const RUST_UI_CRATE = "cmd/cheasee-pi/embedded/docker/ui/";

/** Test-file conventions of languages the inventory has no enumerator for. */
const UNSUPPORTED_TEST_FILE: ReadonlyArray<{ readonly language: string; readonly match: RegExp }> =
	[
		{ language: "rust", match: /\.rs$/ },
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

	it("finds the tracked tree it is guarding", () => {
		assert.ok(files.length > 100, `walked ${files.length} files from ${ROOT}`);
	});

	it("only the documented Rust UI crate holds tests the inventory cannot enumerate", () => {
		const offenders: string[] = [];
		for (const file of files) {
			for (const rule of UNSUPPORTED_TEST_FILE) {
				if (!rule.match.test(file)) continue;
				if (rule.language === "rust" && file.startsWith(RUST_UI_CRATE)) continue;
				offenders.push(`${file} (${rule.language})`);
			}
		}
		assert.deepEqual(
			offenders,
			[],
			`a test suite in an un-enumerated language would escape the audit; add its ` +
				`enumerator to lib/inventory-file.ts or document the exemption in SKILL.md: ${offenders.join(", ")}`,
		);
	});

	it("the exemption is stated in SKILL.md, next to the discovery table", () => {
		const skill = readFileSync(resolve(SKILL, "SKILL.md"), "utf8");
		assert.match(skill, /\*\*What is not audited\.\*\*/);
		assert.ok(skill.includes(RUST_UI_CRATE), "SKILL.md names the un-audited Rust crate");
		assert.match(skill, /no Rust toolchain/i);
	});
});
