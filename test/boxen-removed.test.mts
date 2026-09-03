/**
 * Verify boxen dependency removal (#1607):
 * - package.json dependencies has no boxen key
 * - knip.ignoreDependencies is exactly ["prettier"] (boxen unhidden, prettier kept)
 * - package-lock.json root dep key sets match package.json (no stale lockfile)
 * - no node_modules/boxen entry in the lockfile
 * - docs/sbom.md no longer lists a boxen row
 * - chalk still present in the lockfile (shared transitive, must not be over-pruned)
 *
 * This test must FAIL when the removal is reverted (TDD gate verification).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

interface PackageJson {
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	knip?: { ignoreDependencies?: string[] };
}

function readPackageJson(): PackageJson {
	return JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
}

function readLockfile(): {
	packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
} {
	return JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf-8"));
}

describe("boxen dependency removal", () => {
	it("package.json dependencies has no boxen key", () => {
		const pkg = readPackageJson();
		assert.ok(
			!(pkg.dependencies && "boxen" in pkg.dependencies),
			"package.json dependencies still contains a boxen key",
		);
	});

	it("knip.ignoreDependencies deep-equals exactly ['prettier']", () => {
		const pkg = readPackageJson();
		assert.deepStrictEqual(
			pkg.knip?.ignoreDependencies,
			["prettier"],
			"knip.ignoreDependencies must be exactly ['prettier']",
		);
	});

	it("lockfile root dependency key sets match package.json", () => {
		const pkg = readPackageJson();
		const lock = readLockfile();
		const root = lock.packages[""];
		const lockDeps = new Set([
			...(root?.dependencies ? Object.keys(root.dependencies) : []),
			...(root?.devDependencies ? Object.keys(root.devDependencies) : []),
		]);
		const pkgDeps = new Set([
			...(pkg.dependencies ? Object.keys(pkg.dependencies) : []),
			...(pkg.devDependencies ? Object.keys(pkg.devDependencies) : []),
		]);
		assert.deepStrictEqual(
			[...lockDeps].sort(),
			[...pkgDeps].sort(),
			"lockfile root dependency key sets must match package.json (stale lockfile?)",
		);
	});

	it("lockfile has no node_modules/boxen entry", () => {
		const lock = readLockfile();
		assert.ok(
			!("node_modules/boxen" in lock.packages),
			"package-lock.json still contains a node_modules/boxen entry",
		);
	});

	it("docs/sbom.md contains no boxen row", () => {
		const sbom = readFileSync(resolve(ROOT, "docs/sbom.md"), "utf-8");
		assert.ok(
			!sbom.includes("`boxen`"),
			"docs/sbom.md still lists a boxen row",
		);
	});

	it("lockfile still contains chalk (shared transitive)", () => {
		const lock = readLockfile();
		// chalk's only consumer is @earendil-works/pi-coding-agent (exact pin 5.6.2).
		// Placement is npm's choice — hoisted top-level or nested under the consumer —
		// so assert presence at any node_modules path, not a specific key.
		const chalkEntries = Object.keys(lock.packages).filter((p) =>
			p.endsWith("node_modules/chalk"),
		);
		assert.ok(
			chalkEntries.length > 0,
			"package-lock.json lost chalk (shared transitive must remain)",
		);
	});
});