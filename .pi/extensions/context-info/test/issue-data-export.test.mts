/**
 * Tests: the retired `setSupervisorIssueData` / `clearSupervisorIssueData`
 * write path (issue #2091)
 *
 * The context-info extension used to expose two helpers that mutated the live
 * FooterState through a module-level `stateRef`. Nothing in production ever
 * called them (the supervisor emits on the shared `pi.events` bus instead) and
 * `preflight.ts` records that the `stateRef` inside a second module instance
 * was never set. The helpers are gone; these assertions freeze that removal so
 * a second write path into the footer cannot come back unnoticed.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/issue-data-export.test.mts
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXTENSIONS_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Every production source file under `.pi/extensions/**`, test dirs excluded. */
function productionSources(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "test" || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			productionSources(full, acc);
		} else if (/\.(ts|mts)$/.test(entry.name)) {
			acc.push(full);
		}
	}
	return acc;
}

function readContextInfoIndex(): string {
	return readFileSync(join(EXTENSIONS_ROOT, "context-info", "index.ts"), "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context-info/index.ts — helper exports removed", () => {
	it("exports neither setSupervisorIssueData nor clearSupervisorIssueData", () => {
		const source = readContextInfoIndex();
		assert.ok(
			!/export\s+(function|const)\s+setSupervisorIssueData\b/.test(source),
			"setSupervisorIssueData must not be exported",
		);
		assert.ok(
			!/export\s+(function|const)\s+clearSupervisorIssueData\b/.test(source),
			"clearSupervisorIssueData must not be exported",
		);
	});

	it("keeps no module-level stateRef identifier", () => {
		const source = readContextInfoIndex();
		assert.ok(!/\bstateRef\b/.test(source), "stateRef (variable or comment) must be gone");
	});
});

describe("issue-data footer writes — single path", () => {
	it("no production source references the removed helpers", () => {
		const offenders: string[] = [];
		for (const file of productionSources(EXTENSIONS_ROOT)) {
			const source = readFileSync(file, "utf8");
			if (/setSupervisorIssueData|clearSupervisorIssueData/.test(source)) offenders.push(file);
		}
		assert.deepEqual(offenders, [], "only the bus listener may write issue data");
	});

	it("only events-data.ts assigns the three issue footer fields", () => {
		const writers = new Set<string>();
		for (const file of productionSources(EXTENSIONS_ROOT)) {
			const source = readFileSync(file, "utf8");
			if (/footerConfig\.(issueNumber|issueRepo|issueTitle)\.value\s*=/.test(source)) {
				writers.add(file.slice(EXTENSIONS_ROOT.length));
			}
		}
		assert.deepEqual([...writers], ["context-info/events-data.ts"]);
	});
});

describe("context-info README — documents the bus, not the exports", () => {
	it("no longer claims setSupervisorIssueData/clearSupervisorIssueData", () => {
		const readme = readFileSync(join(EXTENSIONS_ROOT, "context-info", "README.md"), "utf8");
		assert.ok(
			!readme.includes("setSupervisorIssueData"),
			"README must not advertise a removed export",
		);
		assert.ok(
			!readme.includes("clearSupervisorIssueData"),
			"README must not advertise a removed export",
		);
	});
});
