// ─── Tests: lib/tool-call-text.ts (issue #2098) ──────────────────
// Phase 7 — plain-text tool-call formatting separated from the TUI
// primitives. Formatting output must not drift; the render-helpers module
// must be free of the pi tool-factory drag.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/tool-call-text.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToolCallText } from "../lib/tool-call-text.ts";
import { getBuiltinToolLabels } from "../lib/tool-line.ts";
import { readGraph } from "../../lib/test/source-graph.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, "../lib");
const CWD = "/repo";

const PI_TOOL_FACTORIES = [
	"createBashToolDefinition",
	"createReadToolDefinition",
	"createEditToolDefinition",
	"createWriteToolDefinition",
	"createGrepToolDefinition",
	"createFindToolDefinition",
	"createLsToolDefinition",
];

// ═══════════════════════════════════════════════════════════════════
// Plain-text formatting — unchanged output
// ═══════════════════════════════════════════════════════════════════

describe("renderToolCallText() — plain text from the new module", () => {
	it("formats a bash call as pi does", () => {
		assert.equal(renderToolCallText("bash", { command: "npm test" }, CWD), "$ npm test");
	});

	it("formats a read call with its 1-indexed range", () => {
		assert.equal(
			renderToolCallText("read", { path: "/path/file.ts", offset: 10, limit: 30 }, CWD),
			"read /path/file.ts:10-39",
		);
	});

	it("falls back to a JSON preview for extension tools", () => {
		const result = renderToolCallText("ripgrep_search", { query: "TODO" }, CWD);
		assert.ok(result.startsWith("ripgrep_search: "), result);
		assert.ok(result.includes("TODO"), result);
	});

	it("clips an unknown tool's preview to at most 80 chars ending in ...", () => {
		const result = renderToolCallText("unknown_tool", { a: "x".repeat(400) }, CWD);
		assert.ok(result.length <= 80, `preview must be clipped, got ${result.length} chars`);
		assert.ok(result.endsWith("..."), result);
	});

	it("renders the built-in empty-args lines", () => {
		const expected: Record<string, string> = {
			bash: "$ ...",
			read: "read ...",
			write: "write ...",
			edit: "edit ...",
			grep: "grep // in .",
			find: "find  in .",
			ls: "ls .",
		};
		for (const [name, want] of Object.entries(expected)) {
			assert.equal(renderToolCallText(name, undefined, CWD), want, `${name} with undefined args`);
		}
	});

	it("keeps ensureTheme idempotent across sequential calls", () => {
		const outputs: string[] = [];
		for (let i = 0; i < 6; i++) {
			outputs.push(renderToolCallText("bash", { command: "npm test" }, CWD));
		}
		for (const out of outputs) assert.equal(out, outputs[0]);
		assert.equal(outputs[0], "$ npm test");
	});

	it("keeps the exported 3-argument signature", () => {
		const fn: (name: string, args: unknown, cwd: string) => string = renderToolCallText;
		assert.equal(typeof fn, "function");
		assert.equal(renderToolCallText.length, 3);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Structural split — the two modules own different concerns
// ═══════════════════════════════════════════════════════════════════

describe("lib split — plain text vs TUI primitives", () => {
	it("tool-call-text.ts declares renderToolCallText", () => {
		assert.ok(
			readGraph(join(LIB_DIR, "tool-call-text.ts")).declarations.includes("renderToolCallText"),
		);
	});

	it("render-helpers.ts declares none of the plain-text helpers", () => {
		const declarations = readGraph(join(LIB_DIR, "render-helpers.ts")).declarations;
		for (const name of ["renderToolCallText", "formatJsonPreview", "ensureTheme"]) {
			assert.ok(!declarations.includes(name), `render-helpers must not declare ${name}`);
		}
	});

	it("render-helpers.ts no longer re-exports getBuiltinToolLabels", () => {
		const graph = readGraph(join(LIB_DIR, "render-helpers.ts"));
		assert.ok(
			!graph.namedReExports.includes("getBuiltinToolLabels"),
			"the backward-compat re-export must be gone",
		);
		assert.ok(
			getBuiltinToolLabels() instanceof Set,
			"getBuiltinToolLabels still resolves from lib/tool-line.ts",
		);
	});

	it("render-helpers.ts imports none of pi's tool factories", () => {
		const imported = readGraph(join(LIB_DIR, "render-helpers.ts")).importedNames;
		for (const factory of PI_TOOL_FACTORIES) {
			assert.ok(!imported.includes(factory), `render-helpers must not import ${factory}`);
		}
	});

	it("tool-call-text.ts does not depend on pi-tui", () => {
		const specifiers = readGraph(join(LIB_DIR, "tool-call-text.ts")).specifiers;
		assert.ok(!specifiers.some((s) => s.includes("@earendil-works/pi-tui")));
	});
});
