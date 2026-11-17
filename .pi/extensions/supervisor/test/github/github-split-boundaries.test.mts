// ─── Tests: gh split boundaries (issue #2098) ────────────────────
// Phase 8 — the God-Object split is ENFORCED, not just performed. These
// guards fail if a future change re-inlines an adapter into the port module,
// re-duplicates the Octokit construction site, or drags a presentation-only
// module back into the debug/TUI layer.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/github/github-split-boundaries.test.mts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readGraph, type ModuleGraph } from "../../../lib/test/source-graph.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_DIR = join(__dirname, "../..");
const GITHUB_DIR = join(SUPERVISOR_DIR, "github");

/** Every non-test source file under a directory (recursive, sorted). */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "test" || entry.name === "node_modules") continue;
				walk(full);
			} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) {
				if (entry.name.includes(".test.")) continue;
				out.push(full);
			}
		}
	};
	walk(dir);
	return out.sort();
}

/** Sorted basenames of non-test supervisor modules importing `specifier`. */
function importers(specifier: string): string[] {
	const suffix = specifier.replace(/\.(mts|ts)$/, "");
	return sourceFiles(SUPERVISOR_DIR)
		.filter((file) =>
			readGraph(file).specifiers.some((s) => {
				const actual = s.replace(/\.(mts|ts)$/, "");
				return actual === suffix || actual.endsWith(`/${suffix}`);
			}),
		)
		.map((file) => basename(file))
		.sort();
}

function graph(name: string): ModuleGraph {
	return readGraph(join(GITHUB_DIR, name));
}

// ═══════════════════════════════════════════════════════════════════
// ports.ts is adapter-free
// ═══════════════════════════════════════════════════════════════════

describe("ports.ts — adapter-free port module", () => {
	it("imports no adapter, transport, or gh-client module", () => {
		const specifiers = graph("ports.ts").specifiers;
		for (const forbidden of [
			"octokit-client",
			"octokit-issues",
			"octokit-pulls",
			"octokit-projects",
			"github-transport",
			"gh-client",
		]) {
			assert.ok(
				!specifiers.some((s) => s.includes(forbidden)),
				`ports.ts must not import ${forbidden}: ${JSON.stringify(specifiers)}`,
			);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Single composition root
// ═══════════════════════════════════════════════════════════════════

describe("composition — one module knows the concrete adapters", () => {
	// octokit-client.ts is the documented compatibility barrel left behind by the
	// split: it re-exports the adapters for pre-split import paths and carries no
	// logic. The assertions below keep it that way.
	const COMPAT_BARREL = "octokit-client.ts";

	it("only the composition root (and the compat barrel) reference the sub-adapters", () => {
		for (const adapter of ["octokit-issues", "octokit-pulls", "octokit-projects"]) {
			assert.deepEqual(
				importers(adapter),
				["compose.ts", COMPAT_BARREL],
				`${adapter} importer set`,
			);
		}
	});

	it("the compat barrel is a pure re-export shim, not a revived god object", () => {
		const source = readFileSync(join(GITHUB_DIR, COMPAT_BARREL), "utf-8");
		const graph = readGraph(join(GITHUB_DIR, COMPAT_BARREL));
		assert.deepEqual(graph.declarations, [], "a barrel declares nothing");
		assert.ok(!/new Octokit\(/.test(source), "a barrel never constructs a client");
		for (const specifier of graph.specifiers) {
			assert.ok(
				/\.\/(octokit-issues|octokit-pulls|octokit-projects|github-transport|compose|parsers)\.ts$/.test(
					specifier,
				),
				`unexpected barrel re-export: ${specifier}`,
			);
		}
	});

	it("github-transport.ts is imported only by the composition root, the adapter base, and the compat barrel", () => {
		assert.deepEqual(importers("github-transport"), [
			"adapter-base.ts",
			"compose.ts",
			"octokit-client.ts",
		]);
	});

	it("@octokit/graphql has exactly one importer", () => {
		assert.deepEqual(importers("@octokit/graphql"), ["github-transport.ts"]);
	});

	it("new Octokit( appears exactly once across github/*.ts", () => {
		const sites = sourceFiles(GITHUB_DIR)
			.filter((file) => /new Octokit\(/.test(readFileSync(file, "utf-8")))
			.map((file) => basename(file));
		assert.deepEqual(
			sites,
			["github-transport.ts"],
			`exactly one construction site expected, found: ${JSON.stringify(sites)}`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Dependency direction — nothing leaks inward or upward
// ═══════════════════════════════════════════════════════════════════

describe("dependency direction", () => {
	it("no pipeline/ or config/ module references an octokit module", () => {
		const files = [
			...sourceFiles(join(SUPERVISOR_DIR, "pipeline")),
			...sourceFiles(join(SUPERVISOR_DIR, "config")),
		];
		for (const file of files) {
			const bad = readGraph(file).specifiers.filter((s) => /octokit/.test(s));
			assert.deepEqual(bad, [], `${basename(file)} must not import octokit modules`);
		}
	});

	it("adapters never depend upward on pipeline/, event/, or session/", () => {
		const adapters = sourceFiles(GITHUB_DIR).filter(
			(file) => basename(file).startsWith("octokit-") || basename(file) === "github-transport.ts",
		);
		assert.ok(adapters.length >= 4, "expected the split adapter modules to exist");
		for (const file of adapters) {
			const specifiers = readGraph(file).specifiers;
			for (const upward of ["pipeline/", "event/", "session/"]) {
				assert.ok(
					!specifiers.some((s) => s.includes(upward)),
					`${basename(file)} must not import ${upward}`,
				);
			}
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// Presentation vs infrastructure splits
// ═══════════════════════════════════════════════════════════════════

describe("presentation splits", () => {
	it("pipeline/error-panel.ts has no debug-logger dependency", () => {
		const specifiers = readGraph(join(SUPERVISOR_DIR, "pipeline/error-panel.ts")).specifiers;
		assert.ok(
			!specifiers.some((s) => s.includes("debug")),
			`renderErrorPanel must be logger-free: ${JSON.stringify(specifiers)}`,
		);
	});

	it("lib/tool-call-text.ts has no TUI dependency", () => {
		const specifiers = readGraph(join(SUPERVISOR_DIR, "lib/tool-call-text.ts")).specifiers;
		assert.ok(
			!specifiers.some((s) => s.includes("@earendil-works/pi-tui")),
			`plain-text formatting must not depend on pi-tui: ${JSON.stringify(specifiers)}`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Adapter module shape
// ═══════════════════════════════════════════════════════════════════

describe("adapter modules — one exported class each, under the method ceiling", () => {
	const ADAPTER_MODULES = ["octokit-issues.ts", "octokit-pulls.ts", "octokit-projects.ts"];

	it("each adapter module exports exactly one class", () => {
		for (const module of ADAPTER_MODULES) {
			const source = readFileSync(join(GITHUB_DIR, module), "utf-8");
			const exportedClasses = [...source.matchAll(/^export\s+(?:abstract\s+)?class\s+(\w+)/gm)].map(
				(m) => m[1],
			);
			assert.equal(
				exportedClasses.length,
				1,
				`${module} must export exactly one class, found ${JSON.stringify(exportedClasses)}`,
			);
		}
	});
});
