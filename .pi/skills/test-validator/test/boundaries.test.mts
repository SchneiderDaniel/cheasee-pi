// Phase 8 (mechanical) — layer boundaries. The domain and use case must stay
// free of fs, subprocess, environment, and SDK access, and exactly one adapter
// may own each external seam.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SKILL_DIR = dirname(import.meta.dirname);
const LIB_DIR = join(SKILL_DIR, "lib");

function read(relative: string): string {
	return readFileSync(join(SKILL_DIR, relative), "utf8");
}

/** Modules that must not touch the world: domain entities and the use case. */
const PURE_MODULES = [
	"lib/types.ts",
	"lib/ports.ts",
	"lib/inventory.ts",
	"lib/inventory-parse.ts",
	"lib/inventory-bindings.ts",
	"lib/inventory-scope.ts",
	"lib/inventory-callee.ts",
	"lib/inventory-exclusion.ts",
	"lib/inventory-go.ts",
	"lib/inventory-go-braces.ts",
	"lib/inventory-go-literals.ts",
	"lib/inventory-braces.ts",
	"lib/inventory-rust.ts",
	"lib/inventory-rust-literals.ts",
	"lib/inventory-rust-scan.ts",
	"lib/inventory-rust-lex.ts",
	"lib/inventory-rust-code.ts",
	"lib/inventory-rust-modes.ts",
	"lib/inventory-rust-attributes.ts",
	"lib/inventory-rust-modules.ts",
	"lib/inventory-python.ts",
	"lib/inventory-file.ts",
	"lib/inventory-context.ts",
	"lib/checkpoint-schema.ts",
	"lib/checkpoint-fields.ts",
	"lib/checkpoint-record-schema.ts",
	"lib/checkpoint-verdict-gate.ts",
	"lib/decision.ts",
	"lib/decision-schema.ts",
	"lib/decision-evidence.ts",
	"lib/decision-prompt.ts",
	"lib/fingerprint.ts",
	"lib/report.ts",
	"lib/run.ts",
	"lib/run-error.ts",
	"lib/run-pool.ts",
	"lib/run-filing.ts",
];

/** The `node:test` scanner family: the only files allowed to parse code. */
const INVENTORY_FAMILY = /^lib\/inventory.*\.ts$/;

/** The only modules allowed to touch the filesystem, each owning one seam. */
const FS_MODULES = [
	"lib/checkpoint-archive.ts",
	"lib/checkpoint-reader.ts",
	"lib/checkpoint.ts",
	"lib/inventory-file-list.ts",
	"lib/inventory-file-names.ts",
	"lib/inventory-repository.ts",
];

const FORBIDDEN_IN_PURE: Array<{ pattern: RegExp; why: string }> = [
	{ pattern: /from "node:fs"/, why: "filesystem access" },
	{ pattern: /from "node:child_process"/, why: "subprocess access" },
	{ pattern: /process\.env/, why: "environment access" },
	{ pattern: /@earendil-works\/pi-ai/, why: "model SDK access" },
	{ pattern: /proper-lockfile/, why: "lock adapter access" },
	{ pattern: /from "\.\/adapters\//, why: "an adapter import" },
	{ pattern: /from "\.\.\/adapters\//, why: "an adapter import" },
];

describe("boundaries: pure layers", () => {
	it("keeps fs, subprocess, env, and SDK access out of the domain and use case", () => {
		for (const module of PURE_MODULES) {
			const source = read(module);
			for (const { pattern, why } of FORBIDDEN_IN_PURE) {
				assert.equal(pattern.test(source), false, `${module} must not use ${why}`);
			}
		}
	});

	it("keeps the syntax tree dependency confined to the inventory family", () => {
		for (const module of PURE_MODULES) {
			const source = read(module);
			if (INVENTORY_FAMILY.test(module)) continue;
			assert.equal(source.includes('from "typescript"'), false, `${module} must not parse code`);
		}
		assert.match(read("lib/inventory-parse.ts"), /from "typescript"/);
	});

	it("confines filesystem access to the modules that own a seam", () => {
		assert.deepEqual(
			readdirSync(LIB_DIR)
				.filter((name) => name.endsWith(".ts"))
				.map((name) => `lib/${name}`)
				.filter((module) => /from "node:fs"/.test(read(module)))
				.sort(),
			FS_MODULES,
		);
	});

	it("confines the lock adapter to the checkpoint lock seam", () => {
		const lockers = readdirSync(LIB_DIR)
			.filter((name) => name.endsWith(".ts"))
			.map((name) => `lib/${name}`)
			.filter((module) => /proper-lockfile/.test(read(module)));

		assert.deepEqual(lockers, ["lib/checkpoint-lock.ts"]);
	});

	it("exports no shell or network call from the domain", () => {
		for (const module of ["lib/decision.ts", "lib/report.ts", "lib/fingerprint.ts", "lib/run.ts"]) {
			const source = read(module);
			assert.equal(
				/child_process|spawn|exec|fetch\(/.test(source),
				false,
				`${module} must stay pure`,
			);
		}
	});
});

describe("boundaries: adapters own their seam", () => {
	const adapterFiles = readdirSync(join(LIB_DIR, "adapters"))
		.filter((name) => name.endsWith(".ts"))
		.sort();

	it("ships exactly the adapters the architecture names", () => {
		assert.deepEqual(adapterFiles, ["decision-model-pi-ai.ts", "issue-gh.ts", "pi-ai-catalog.ts"]);
	});

	it("imports the model SDK only in the pi-ai adapter family", () => {
		const importers: string[] = [];
		for (const file of [...PURE_MODULES, ...adapterFiles.map((name) => `lib/adapters/${name}`)]) {
			if (read(file).includes('from "@earendil-works/pi-ai')) importers.push(file);
		}
		assert.deepEqual(importers, [
			"lib/adapters/decision-model-pi-ai.ts",
			"lib/adapters/pi-ai-catalog.ts",
		]);
	});

	it("shells out only from the gh adapter", () => {
		const shellers: string[] = [];
		for (const file of [...PURE_MODULES, ...adapterFiles.map((name) => `lib/adapters/${name}`)]) {
			if (/node:child_process|spawnArgv/.test(read(file))) shellers.push(file);
		}
		assert.deepEqual(shellers, ["lib/adapters/issue-gh.ts"]);
	});

	it("routes the gh adapter through the shared argv-safety seam", () => {
		const source = read("lib/adapters/issue-gh.ts");

		assert.match(source, /spawnArgv\(/);
		assert.equal(/shell:\s*true/.test(source), false);
	});
});

describe("boundaries: skill layout", () => {
	it("keeps logic in lib/ and orchestration in scripts/", () => {
		const scripts = readdirSync(join(SKILL_DIR, "scripts"));

		assert.ok(scripts.includes("test-validator.mts"));
		const cli = read("scripts/test-validator.mts");
		assert.match(cli, /from "\.\.\/lib\/run\.ts"/);
		assert.match(cli, /from "\.\.\/lib\/checkpoint\.ts"/);
		assert.match(cli, /from "\.\.\/lib\/adapters\/decision-model-pi-ai\.ts"/);
		assert.match(cli, /from "\.\.\/lib\/adapters\/issue-gh\.ts"/);
	});

	it("never reaches into another skill", () => {
		for (const module of PURE_MODULES) {
			assert.equal(
				/skills\/(?!test-validator)/.test(read(module)),
				false,
				`${module} must stay local`,
			);
		}
	});
});
