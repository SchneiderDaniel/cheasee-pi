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
// Configuration is a build input too: pi installs whatever a `packages` entry
// records, so the committed `.pi/settings.json` must not list the package —
// otherwise a rebuilt image loads Ponytail from the checkout again.
//
// Run: node --experimental-strip-types --test test/mode-extensions-removed.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Repository root with every symlink resolved, so a linked directory can be
 *  told apart from repository content when ROOT itself sits behind a link. */
const REAL_ROOT = realpathSync(ROOT);

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

/** The exact package source pi would reinstall and then load. The bare word is
 *  deliberately not the needle: `ponytail:` deferral markers in unrelated
 *  sources are an orphaned convention with zero runtime effect. */
const PONYTAIL_SOURCE = "DietrichGebert/ponytail";

/** Config files pi and the container read. None may carry the package. */
const PACKAGE_CONFIG_FILES = [
	".pi/settings.json",
	"cmd/cheasee-pi/embedded/pi/settings.json",
	"cmd/cheasee-pi/embedded/docker/entrypoint.sh",
	"cmd/cheasee-pi/embedded/docker/Dockerfile",
];

/** Production roots swept for the package source (tests and fixtures excluded). */
const PACKAGE_SOURCE_ROOTS = [".pi", "cmd", "scripts", ".github"];

/** Repo-relative directory prefixes that are operator state, not repository
 *  content: `.pi/git` holds installed package clones (including a stale
 *  Ponytail checkout in existing workspaces) and `.pi/sessions` transcripts. */
const PRUNED_PREFIXES = [".pi/git/", ".pi/sessions/"];

/** Directory names never descended into: vendored installs, VCS metadata. */
const PRUNED_DIR_NAMES = new Set(["node_modules", ".git"]);

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const isFile = (rel: string): boolean => {
	try {
		return statSync(resolve(ROOT, rel)).isFile();
	} catch {
		return false;
	}
};

/** Whether a directory entry is a file, a directory, or neither. Symlinks are
 *  resolved once: a worktree links its Python venvs into `.pi/` (reading those
 *  trees would bury the sweep in environment files) and a dangling link
 *  resolves to nothing. */
function entryKind(full: string): "file" | "dir" | "skip" {
	try {
		const stats = statSync(full);
		if (stats.isFile()) return "file";
		if (!stats.isDirectory()) return "skip";
		// A linked directory is walked only while it stays inside the repository.
		return realpathSync(full).startsWith(`${REAL_ROOT}${sep}`) ? "dir" : "skip";
	} catch {
		// A dangling symlink resolves to nothing: there is nothing to read and no
		// tree to descend, so every sweep skips it.
		return "skip";
	}
}

/** Every file under a repo-relative root, as repo-relative paths. Vendored
 *  installs, VCS metadata and operator state are never descended into — the
 *  latter keeps untracked clones (`.pi/git`) out of every sweep. */
function walk(rel: string): string[] {
	const abs = resolve(ROOT, rel);
	const out: string[] = [];
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const child = relative(ROOT, full);
			const kind = entryKind(full);
			if (kind === "dir") {
				if (PRUNED_DIR_NAMES.has(entry.name)) continue;
				if (PRUNED_PREFIXES.some((prefix) => `${child}/`.startsWith(prefix))) continue;
				visit(full);
				continue;
			}
			if (kind === "skip") continue;
			out.push(child);
		}
	};
	visit(abs);
	return out;
}

/** Production sources: no test suite, no fixture, no vendored clone, no
 *  workspace state. */
function productionSources(rel: string): string[] {
	if (isFile(rel)) return [rel];
	return walk(rel).filter(
		(p) =>
			!/\.(test|spec)\.(mts|ts|js)$/.test(p) &&
			!/_test\.go$/.test(p) &&
			!p.split("/").some((part) => part === "test" || part === "tests" || part === "fixtures") &&
			!PRUNED_PREFIXES.some((prefix) => p.startsWith(prefix)) &&
			!p.split("/").includes("node_modules"),
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

	it("every package entry is a bare source string", () => {
		const settings = JSON.parse(read(".pi/settings.json")) as { packages?: unknown };
		const entries = settings.packages;
		assert.ok(Array.isArray(entries), "committed packages must be a list");
		for (const entry of entries) {
			assert.equal(
				typeof entry,
				"string",
				`package entry must be a bare source string, got ${JSON.stringify(entry)}`,
			);
		}
	});

	it("the raw settings file names neither the package nor its skill filter", () => {
		const raw = read(".pi/settings.json");
		assert.equal(raw.includes(PONYTAIL_SOURCE), false, `settings still name ${PONYTAIL_SOURCE}`);
		assert.equal(
			raw.includes("ponytail-*"),
			false,
			"settings still carry the ponytail-* skill filter",
		);
	});

	it("the settings keep the prompts key", () => {
		const settings = JSON.parse(read(".pi/settings.json")) as { prompts?: unknown };
		assert.ok("prompts" in settings, "committed settings must keep the prompts key");
		assert.deepEqual(settings.prompts, []);
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

describe("response modes #2072 — no config can reinstall the Ponytail package", () => {
	it("neither pi nor the container config names the package", () => {
		const hits: string[] = [];
		for (const rel of PACKAGE_CONFIG_FILES) {
			const content = read(rel);
			if (content.includes(PONYTAIL_SOURCE)) hits.push(`${rel} names ${PONYTAIL_SOURCE}`);
			if (content.includes("ponytail-*")) hits.push(`${rel} carries the ponytail-* skill filter`);
		}
		assert.deepEqual(hits, [], "a committed config still installs Ponytail");
	});

	it("the config sweep has teeth and covers every file", () => {
		const sample = `{"source": "https://github.com/${PONYTAIL_SOURCE}"}`;
		assert.ok(sample.includes(PONYTAIL_SOURCE), "the config needle is not a literal");
		for (const rel of PACKAGE_CONFIG_FILES) {
			assert.ok(isFile(rel), `${rel} must exist — a missing file makes the sweep vacuous`);
		}
	});

	it("no production source names the package source", () => {
		const files = PACKAGE_SOURCE_ROOTS.flatMap(productionSources);
		assert.ok(files.length > 50, `package source sweep found only ${files.length} files`);
		const hits = files.filter((rel) => read(rel).includes(PONYTAIL_SOURCE));
		assert.deepEqual(hits, [], `${PONYTAIL_SOURCE} is still recorded in production source`);
	});

	it("the sweep matches the source, not the bare word", () => {
		// `.pi/extensions/rtk/index.ts` carries an orphaned `ponytail:` deferral
		// marker. It must not trip the sweep, which proves the needle is the exact
		// package source and not the feature word.
		const rtk = ".pi/extensions/rtk/index.ts";
		assert.equal(read(rtk).includes(PONYTAIL_SOURCE), false, `${rtk} must not name the source`);
		assert.match(read(rtk), /ponytail/i, `${rtk} must still carry the deferral marker`);
	});

	it("the sweep descends into no untracked clone or session state", () => {
		const swept = PACKAGE_SOURCE_ROOTS.flatMap(productionSources);
		const leaked = swept.filter(
			(p) =>
				PRUNED_PREFIXES.some((prefix) => p.startsWith(prefix)) ||
				p.split("/").includes("node_modules"),
		);
		assert.deepEqual(leaked, [], "the sweep must stay scoped to repository content");
		// The stale checkout existing in a workspace is operator state, not a repo
		// artifact: it must never be swept, and it must never be deleted by tests.
		const checkout = ".pi/git/github.com/DietrichGebert/ponytail";
		if (existsSync(resolve(ROOT, checkout))) {
			assert.equal(
				swept.includes(checkout),
				false,
				`${checkout} is untracked workspace state and must not be swept`,
			);
		}
	});
});

describe("response modes #2072 — docs carry no feature pages", () => {
	it("the two feature pages are deleted", () => {
		for (const rel of MODE_DOCS) {
			assert.equal(existsSync(resolve(ROOT, rel)), false, `${rel} must be absent`);
		}
	});

	it("no doc page links to a deleted feature page", () => {
		const removed = MODE_DOCS.map((rel) => resolve(ROOT, rel));
		const linked: string[] = [];
		for (const rel of docFiles()) {
			for (const target of relativeMarkdownLinks(rel)) {
				if (removed.includes(target)) linked.push(`${rel} -> ${relative(ROOT, target)}`);
			}
		}
		assert.deepEqual(linked, [], "a doc page still links to a removed feature page");
	});

	it("installation.md is the one page exempt from the feature-word ban", () => {
		assert.ok(
			DOC_EXEMPT.has("docs/installation.md"),
			"docs/installation.md must stay exempt: it carries the package cleanup path",
		);
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
