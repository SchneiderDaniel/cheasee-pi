/**
 * Unit + adapter tests for the test-registration/discovery helper (issue #1859).
 *
 * The helper reads `package.json#scripts.test` and expands its globs, so the
 * pure core (parseTokens / isGlobBased / expandGlobs) is exercised directly for
 * negative paths and the fs-backed wrappers are checked against an independent
 * readdirSync walk. No mocking: real filesystem, real repo.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, matchesGlob } from "node:path";
import { tmpdir } from "node:os";

import {
	parseTokens,
	isGlobBased,
	expandGlobs,
	testScript,
	testGlobs,
	discoverTestFiles,
	isRegistered,
} from "./test-discovery.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** Independent readdirSync walk mirroring the glob scope: .pi/extensions/** + test/**. */
function walkTestFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "fixtures" || entry.name === "node_modules") continue;
				walk(full);
			} else if (/\.test\.(mts|ts)$/.test(entry.name)) {
				out.push(full.slice(REPO_ROOT.length + 1));
			}
		}
	};
	for (const root of [join(REPO_ROOT, ".pi", "extensions"), join(REPO_ROOT, "test")]) {
		walk(root);
	}
	return out.sort();
}

describe("test-discovery core (#1859)", () => {
	it("parseTokens returns exactly the three unquoted glob tokens of scripts.test", () => {
		const tokens = parseTokens(testScript());
		assert.strictEqual(tokens.length, 3, `expected 3 glob tokens, got ${tokens.join(" ")}`);
		for (const token of tokens) {
			assert.ok(token.includes("*"), `token is not a glob: ${token}`);
			assert.ok(
				!/^['"]/.test(token) && !/['"]$/.test(token),
				`token retains surrounding quotes: ${token}`,
			);
		}
	});

	it("isGlobBased accepts glob scripts and rejects literal rosters", () => {
		assert.strictEqual(
			isGlobBased("node --experimental-strip-types --test 'a/**/*.test.mts'"),
			true,
		);
		assert.strictEqual(isGlobBased("node --test a.test.mts b.test.mts"), false);
	});

	it("isGlobBased fails closed on empty or non-string input (no throw)", () => {
		assert.strictEqual(isGlobBased(""), false);
		assert.strictEqual(isGlobBased(undefined as unknown as string), false);
	});

	it("the real script holds no bare literal test token (roster cannot silently return)", () => {
		const bare = testScript()
			.split(/\s+/)
			.filter(Boolean)
			.map((t) => t.replace(/^(['"])(.*)\1$/, "$2"))
			.filter((t) => !t.includes("*") && /\.test\.(mts|ts)$/.test(t));
		assert.deepStrictEqual(bare, [], `literal test tokens found: ${bare.join(", ")}`);
		assert.ok(testGlobs().every((t) => t.includes("*")), "every registered token must be a glob");
	});

	it("expandGlobs boundary cases yield no throw and no matches", () => {
		assert.deepStrictEqual(expandGlobs([], REPO_ROOT), []);
		assert.deepStrictEqual(expandGlobs(["no/such/**/*.test.mts"], REPO_ROOT), []);
	});

	it("expandGlobs matches top-level files under `**` (zero segments)", () => {
		const dir = mkdtempSync(join(tmpdir(), "td-glob-"));
		try {
			writeFileSync(join(dir, "top.test.mts"), "");
			mkdirSync(join(dir, "nested"));
			writeFileSync(join(dir, "nested", "deep.test.mts"), "");
			writeFileSync(join(dir, "notes.md"), "");
			const matches = expandGlobs(["**/*.test.mts"], dir).sort();
			assert.deepStrictEqual(matches, ["nested/deep.test.mts", "top.test.mts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("test-discovery adapters (#1859)", () => {
	it("discoverTestFiles set-equals an independent readdirSync walk", () => {
		assert.deepStrictEqual(discoverTestFiles().slice().sort(), walkTestFiles());
	});

	it("discovers commonly-unrun files that issue #1859 called out", () => {
		const files = discoverTestFiles();
		for (const rel of [
			".pi/extensions/lsp-auditor/test/lsp-auditor.test.mts",
			".pi/extensions/ask-user/test/question-handler.test.mts",
			".pi/extensions/lib/test/path-containment.test.ts",
		]) {
			assert.ok(files.includes(rel), `${rel} must be discovered`);
		}
	});

	it("produces no duplicates (overlapping globs must not double-register)", () => {
		const files = discoverTestFiles();
		assert.strictEqual(files.length, new Set(files).size);
	});

	it("glob shapes cover both top-level and nested paths", () => {
		const files = discoverTestFiles();
		assert.ok(files.includes("test/append-system-md.test.mts"), "test/** must match top-level");
		assert.ok(
			files.includes(".pi/extensions/lsp-auditor/test/lsp-auditor.test.mts"),
			".pi/extensions/** must match nested",
		);
	});

	it("isRegistered answers for real, unregistered and non-test paths", () => {
		assert.strictEqual(
			isRegistered(".pi/extensions/lsp-auditor/test/lsp-auditor.test.mts"),
			true,
		);
		assert.strictEqual(isRegistered("test/lib/test-discovery.mts"), false);
		assert.strictEqual(isRegistered("package.json"), false);
	});

	it("registration depends on the globs (a dropped .test.ts glob uncovers .ts tests)", () => {
		const guard = ".pi/extensions/caveman/test/config-ui.test.ts";
		const withoutTs = parseTokens(testScript()).filter((g) => !g.endsWith(".test.ts"));
		assert.strictEqual(
			withoutTs.some((g) => matchesGlob(guard, g)),
			false,
			"removing the .test.ts glob must uncover .ts guard files",
		);
	});
});
