// ─── Removed response modes contract (issue #2072) ────────────────
// Ponytail and Caveman were response-restricting modes: two extension trees,
// a skill link, prompt-injection markers and a default skill repository. They
// are gone from source and build inputs; a rebuilt image must not register,
// install or inject either one.
//
// This guard is deliberately scoped to build inputs, the runtime tree and
// production sources — never to prose. The `ponytail:` deferral markers in
// unrelated Rust/Go/TS sources and `.github/workflows/cli-install-smoke.yml`
// are an orphaned convention name with zero runtime effect and stay untouched.
//
// Run: node --experimental-strip-types --test test/mode-extensions-removed.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Doc pages that documented one mode each. */
const MODE_DOCS = ["docs/extensions/caveman.md", "docs/extensions/ponytail.md"];

/** Every doc file must be free of the feature names — installation.md carries a
 *  one-time upgrade note for workspaces that already recorded the default repo. */
const DOC_EXEMPT = new Set(["docs/installation.md"]);

/** Mode-state identifiers only the deleted extensions read or wrote. */
const MODE_STATE_NEEDLES = [
	"caveman.json",
	"caveman-level",
	"ponytail-mode",
	"PONYTAIL_DEFAULT_MODE",
];

/** Production-source roots swept for mode state (tests and fixtures excluded). */
const PRODUCTION_ROOTS = [".pi/extensions", "cmd", "scripts"];

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const isFile = (rel: string): boolean => {
	try {
		return statSync(resolve(ROOT, rel)).isFile();
	} catch {
		return false;
	}
};

/** Every file under a repo-relative root, as repo-relative paths. */
function walk(rel: string): string[] {
	const abs = resolve(ROOT, rel);
	const out: string[] = [];
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else out.push(relative(ROOT, full));
		}
	};
	visit(abs);
	return out;
}

/** Production sources: no test suite, no fixture, no vendored clone. */
function productionSources(rel: string): string[] {
	if (isFile(rel)) return [rel];
	return walk(rel).filter(
		(p) =>
			!/\.(test|spec)\.(mts|ts|js)$/.test(p) &&
			!p.split("/").some((part) => part === "test" || part === "tests" || part === "fixtures"),
	);
}

/** Markdown files under docs/. */
const docFiles = (): string[] => walk("docs").filter((p) => p.endsWith(".md"));

/** Relative `.md` links that point at a repo file (anchors and URLs excluded). */
function relativeMarkdownLinks(rel: string): string[] {
	const out: string[] = [];
	for (const m of read(rel).matchAll(/\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/g)) {
		const target = m[1]!;
		if (/^[a-z]+:/i.test(target)) continue;
		out.push(resolve(dirname(resolve(ROOT, rel)), target));
	}
	return out;
}

describe("response modes #2072 — the runtime trees are gone", () => {
	it("neither extension tree and no ponytail skill link remains", () => {
		for (const rel of [
			".pi/extensions/caveman",
			".pi/extensions/ponytail",
			".pi/skills/ponytail",
		]) {
			assert.equal(existsSync(resolve(ROOT, rel)), false, `${rel} must be absent`);
		}
	});

	it("the committed project settings keep private-pi and no source filter", () => {
		const settings = JSON.parse(read(".pi/settings.json")) as {
			packages?: unknown[];
		};
		assert.deepEqual(settings.packages, ["https://github.com/SchneiderDaniel/private-pi"]);
	});
});

describe("response modes #2072 — no production source reads or writes mode state", () => {
	const files = PRODUCTION_ROOTS.flatMap(productionSources);

	for (const needle of MODE_STATE_NEEDLES) {
		it(`no production source mentions ${needle}`, () => {
			// Teeth: the matcher must fire on a synthetic sample, so a typo in the
			// needle cannot turn this sweep into a vacuous pass.
			assert.ok(`const x = "${needle}";`.includes(needle), `needle ${needle} is not a literal`);
			const hits = files.filter((rel) => read(rel).includes(needle));
			assert.deepEqual(hits, [], `${needle} is still read or written by production source`);
		});
	}

	it("APPEND_SYSTEM.md injects no mode instructions", () => {
		const append = read("APPEND_SYSTEM.md").toLowerCase();
		for (const term of ["caveman", "ponytail"]) {
			assert.equal(append.includes(term), false, `APPEND_SYSTEM.md still mentions ${term}`);
		}
	});

	it("sweeps a non-trivial source set (the walk is not empty)", () => {
		assert.ok(files.length > 50, `production source sweep found only ${files.length} files`);
	});
});

describe("response modes #2072 — docs carry no feature pages", () => {
	it("the two feature pages are deleted", () => {
		for (const rel of MODE_DOCS) {
			assert.equal(existsSync(resolve(ROOT, rel)), false, `${rel} must be absent`);
		}
	});

	it("no doc page mentions either feature (installation.md exempt)", () => {
		const re = /caveman|ponytail/i;
		assert.ok(re.test("Caveman"), "the doc matcher must fire on a synthetic sample");
		assert.ok(re.test("PONYTAIL"), "the doc matcher is case-insensitive");
		const hits = docFiles().filter((rel) => !DOC_EXEMPT.has(rel) && re.test(read(rel)));
		assert.deepEqual(hits, [], "a doc page still documents a removed mode");
	});

	it("every relative markdown link under docs/ resolves", () => {
		const dangling: string[] = [];
		for (const rel of docFiles()) {
			for (const target of relativeMarkdownLinks(rel)) {
				if (!existsSync(target)) dangling.push(`${rel} -> ${target}`);
			}
		}
		assert.deepEqual(dangling, [], "a doc link points at a file that does not exist");
	});

	it("installation docs no longer install a default skill repository", () => {
		const install = read("docs/installation.md");
		assert.equal(
			/installed by default/i.test(install),
			false,
			"installation docs must not claim a default skill repository",
		);
	});

	it("extension READMEs carry no feature row or example entry", () => {
		const re = /caveman|ponytail/i;
		const hits = walk(".pi/extensions")
			.filter((p) => p.endsWith("README.md"))
			.filter((rel) => re.test(read(rel)));
		assert.deepEqual(hits, [], "an extension README still names a removed mode");
	});
});

describe("response modes #2072 — the prompt-audit layer knows one injection", () => {
	it("zzz-dump-context declares a single injection marker", () => {
		const src = read(".pi/extensions/zzz-dump-context/index.ts");
		assert.match(src, /const INJECTION_MARKERS = \["## Past Session Lessons"\];/);
		assert.equal(/caveman|ponytail/i.test(src), false, "the dump-context source names a mode");
	});

	it("both dump-context fixtures carry the lesson block only", () => {
		for (const rel of [
			".pi/extensions/zzz-dump-context/test/dump-context-append.test.mts",
			".pi/extensions/zzz-dump-context/test/dump-context-cwd.test.mts",
		]) {
			assert.equal(/caveman|ponytail/i.test(read(rel)), false, `${rel} still names a mode`);
		}
	});
});
