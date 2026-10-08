/**
 * Tests: the six single-consumer renderers (compaction, error, budget,
 * tool-start, thinking, phase-change) are folded into
 * `session/message-renderers/render-simple.ts`, and the dead constant
 * `MAX_TASK_PREVIEW_CHARS` plus the stale `file-classification.ts` header
 * are gone (issue #1874).
 *
 * Proves structural absence (no dangling specifiers, no resurrected symbols)
 * and behavioral equivalence of the folded renderers against the dispatch
 * table. Byte-level equivalence is pinned separately by
 * message-renderer-golden.test.mts.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/renderer-fold-removal.test.mts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as simple from "../session/message-renderers/render-simple.ts";
import { RENDERERS, fallbackRenderer } from "../session/message-renderers/index.ts";
import { fallbackRenderer as fallbackDirect } from "../session/message-renderers/fallback-renderer.ts";
import { renderSubagentResult } from "../session/message-renderers/render-subagent.ts";
import { renderToolComplete } from "../session/message-renderers/render-tool-complete.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_ROOT = resolve(__dirname, "..", "..");
const RENDERERS_DIR = join(EXTENSIONS_ROOT, "supervisor", "session", "message-renderers");
const SELF = fileURLToPath(import.meta.url);

const FOLDED = [
	"render-compaction.ts",
	"render-error.ts",
	"render-budget.ts",
	"render-tool-start.ts",
	"render-thinking.ts",
	"render-phase-change.ts",
] as const;

const RENDERER_EXPORTS = [
	"renderBudgetExceeded",
	"renderCompaction",
	"renderError",
	"renderPhaseChange",
	"renderThinking",
	"renderToolStart",
] as const;

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	style: (text: string, _options: any) => text,
};

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderStripped(component: any, width = 80): string[] {
	return component.render(width).map((line: string) => stripAnsi(line).trim());
}

function renderWith(fn: (m: any, o: any, t: any) => any, details: Record<string, unknown>, content?: string) {
	const message: Record<string, unknown> = { details };
	if (content !== undefined) message.content = content;
	return fn(message, {}, mockTheme);
}

/** Recursively collect every .ts/.mts file under root, skipping node_modules. */
function collectSources(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && /\.(ts|mts)$/.test(entry.name)) out.push(full);
		}
	};
	walk(root);
	return out;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1: the fold — render-simple.ts owns the six renderers
// ═══════════════════════════════════════════════════════════════════

describe("render-simple.ts module surface", () => {
	it("exposes exactly the six folded renderers, each a function, no default", async () => {
		const mod = (await import("../session/message-renderers/render-simple.ts")) as Record<
			string,
			unknown
		>;
		assert.deepEqual([...Object.keys(mod)].sort(), [...RENDERER_EXPORTS].sort());
		assert.equal("default" in mod, false);
		for (const name of RENDERER_EXPORTS) {
			assert.equal(typeof mod[name], "function", `${name} must be a function`);
		}
	});
});

describe("RENDERERS dispatch table is a table of values", () => {
	it("each key maps to the exact renderer instance from its owning module", () => {
		assert.equal(RENDERERS["compaction"], simple.renderCompaction);
		assert.equal(RENDERERS["error"], simple.renderError);
		assert.equal(RENDERERS["budget-exceeded"], simple.renderBudgetExceeded);
		assert.equal(RENDERERS["tool-start"], simple.renderToolStart);
		assert.equal(RENDERERS["thinking"], simple.renderThinking);
		assert.equal(RENDERERS["phase-change"], simple.renderPhaseChange);
		assert.equal(RENDERERS["subagent-result"], renderSubagentResult);
		assert.equal(RENDERERS["tool-complete"], renderToolComplete);
	});

	it("has exactly 8 keys and no fallback entry", () => {
		assert.equal(Object.keys(RENDERERS).length, 8);
		assert.equal(RENDERERS["made-up-type"], undefined);
	});

	it("re-exports the same fallback reference as fallback-renderer.ts", () => {
		assert.equal(fallbackRenderer, fallbackDirect);
	});
});

describe("folded renderers — direct render (public contract of render-simple.ts)", () => {
	before(() => {
		initTheme();
	});

	it("compaction → Text '⚠ compacted'", () => {
		const c = renderWith(simple.renderCompaction, {});
		assert.ok(c instanceof Text);
		assert.ok(renderStripped(c).some((l) => l.includes("⚠ compacted")));
	});

	it("error with toolName + reason → '✗ bash: command not found'", () => {
		const c = renderWith(simple.renderError, { toolName: "bash", errorReason: "command not found" });
		assert.ok(c instanceof Text);
		assert.ok(renderStripped(c).some((l) => l.includes("✗ bash: command not found")));
	});

	it("error without reason → '✗ bash: Unknown error'", () => {
		const c = renderWith(simple.renderError, { toolName: "bash" });
		assert.ok(renderStripped(c).some((l) => l.includes("✗ bash: Unknown error")));
	});

	it("error without both → '✗ Unknown error'", () => {
		const c = renderWith(simple.renderError, {});
		assert.ok(renderStripped(c).some((l) => l.includes("✗ Unknown error")));
	});

	it("budget with counts → '⚠ dev — budget exceeded (5 tools, 5000 tokens)'", () => {
		const c = renderWith(simple.renderBudgetExceeded, {
			agentName: "dev",
			toolCount: 5,
			tokenCount: 5000,
		});
		assert.ok(c instanceof Text);
		assert.ok(
			renderStripped(c).some((l) => l.includes("⚠ dev — budget exceeded (5 tools, 5000 tokens)")),
		);
	});

	it("tool-start with args → '⏳ dev — bash ls -la'", () => {
		const c = renderWith(simple.renderToolStart, { agentName: "dev", toolName: "bash", args: "ls -la" });
		assert.ok(c instanceof Text);
		assert.ok(renderStripped(c).some((l) => l.includes("⏳ dev — bash ls -la")));
	});

	it("tool-start without args → '⏳ dev — bash'", () => {
		const c = renderWith(simple.renderToolStart, { agentName: "dev", toolName: "bash" });
		assert.ok(renderStripped(c).some((l) => l.includes("⏳ dev — bash")));
	});

	it("thinking with content → Container", () => {
		const c = renderWith(simple.renderThinking, { content: "Considering the approach" });
		assert.ok(c instanceof Container);
		assert.ok(renderStripped(c).some((l) => l.includes("Considering the approach")));
	});

	it("phase-change with content equal to derived text → Text", () => {
		const c = renderWith(
			simple.renderPhaseChange,
			{ agentName: "dev", phase: "starting" },
			"⏳ dev — starting phase",
		);
		assert.ok(c instanceof Text);
	});
});

describe("folded renderers — boundaries the goldens never hit", () => {
	before(() => {
		initTheme();
	});

	it("budget-exceeded with no agentName/toolCount/tokenCount pins `|| \"\"` and `?? 0`", () => {
		const c = renderWith(simple.renderBudgetExceeded, {});
		assert.ok(c instanceof Text);
		assert.ok(renderStripped(c).some((l) => l.includes("⚠  — budget exceeded (0 tools, 0 tokens)")));
	});

	it("thinking with only thinkingText pins `content || thinkingText`", () => {
		const c = renderWith(simple.renderThinking, { thinkingText: "only a thought" });
		assert.ok(c instanceof Container);
		assert.ok(renderStripped(c).some((l) => l.includes("only a thought")));
	});

	it("phase-change with content starting at newline index 0 pins the `firstNl > 0` guard", () => {
		const c = renderWith(
			simple.renderPhaseChange,
			{ agentName: "dev", phase: "starting" },
			"\nModel: claude-sonnet-4",
		);
		assert.ok(c instanceof Markdown, "firstNl === 0 must fall through to Markdown");
	});

	it("phase-change with a newline after index 0 → Container of [Text, Markdown]", () => {
		const c = renderWith(
			simple.renderPhaseChange,
			{ agentName: "dev", phase: "starting" },
			"⏳ dev — starting phase\nModel: claude-sonnet-4",
		);
		assert.ok(c instanceof Container);
		assert.ok(c.children[0] instanceof Text, "first child is the accent status line");
		assert.ok(c.children[1] instanceof Markdown, "second child is the Markdown body");
	});
});

describe("module graph after the fold", () => {
	const files = readdirSync(RENDERERS_DIR).filter((f) => f.endsWith(".ts"));

	it("owns render-simple.ts (list is non-vacuous)", () => {
		assert.ok(files.includes("render-simple.ts"), `got: ${JSON.stringify(files)}`);
	});

	for (const gone of FOLDED) {
		it(`no longer contains ${gone}`, () => {
			assert.equal(files.includes(gone), false);
		});
	}

	for (const kept of ["render-subagent.ts", "render-tool-complete.ts", "fallback-renderer.ts"]) {
		it(`still contains ${kept}`, () => {
			assert.ok(files.includes(kept));
		});
	}
});

describe("no dangling specifier anywhere under .pi/extensions", () => {
	const sources = collectSources(EXTENSIONS_ROOT).filter((f) => f !== SELF);

	it("scanned a non-vacuous file set", () => {
		assert.ok(sources.length > 50, `only scanned ${sources.length} files`);
	});

	for (const gone of FOLDED) {
		it(`0 references to ${gone}`, () => {
			const offenders = sources.filter((f) => readFileSync(f, "utf8").includes(gone));
			assert.deepEqual(offenders, [], `dangling import of ${gone}`);
		});
	}
});

describe("index.ts is a table of values, not a pointer list", () => {
	const source = readFileSync(join(RENDERERS_DIR, "index.ts"), "utf8");

	it("imports only the four renderer modules plus the type contract", () => {
		const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
		assert.deepEqual(specifiers, [
			"./fallback-renderer.ts",
			"./render-simple.ts",
			"./render-subagent.ts",
			"./render-tool-complete.ts",
			"./types.ts",
		]);
	});

	it("does not unpack details itself", () => {
		assert.equal(source.includes("(message as any).details"), false);
	});

	it("has no dynamic imports", () => {
		assert.equal(source.includes("import("), false);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2: MAX_TASK_PREVIEW_CHARS stays dead
// ═══════════════════════════════════════════════════════════════════

describe("constants.ts — MAX_TASK_PREVIEW_CHARS absent, live caps intact", () => {
	it("module surface holds only the two live caps", async () => {
		const mod = (await import("../session/message-renderers/constants.ts")) as Record<string, unknown>;
		assert.equal("MAX_TASK_PREVIEW_CHARS" in mod, false);
		assert.equal(mod.MAX_EXPANDED_TOOL_CALLS, 30);
		assert.equal(mod.MAX_NESTED_CALLS, 30);
	});

	it("no production .ts/.mts under .pi/extensions references the literal", () => {
		const offenders = collectSources(EXTENSIONS_ROOT)
			.filter((f) => !f.includes("/test/"))
			.filter((f) => readFileSync(f, "utf8").includes("MAX_TASK_PREVIEW_CHARS"));
		assert.deepEqual(offenders, []);
	});

	it("live consumers are not cascaded", () => {
		const subagent = readFileSync(join(RENDERERS_DIR, "render-subagent.ts"), "utf8");
		assert.match(subagent, /MAX_EXPANDED_TOOL_CALLS/);
		const handlers = readFileSync(join(EXTENSIONS_ROOT, "supervisor", "event", "adapter", "handlers.ts"), "utf8");
		assert.match(handlers, /MAX_NESTED_CALLS/);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3: checks/file-classification.ts header names its real consumer
// ═══════════════════════════════════════════════════════════════════

describe("file-classification.ts header", () => {
	const source = readFileSync(
		join(EXTENSIONS_ROOT, "supervisor", "checks", "file-classification.ts"),
		"utf8",
	);

	it("no longer names requirements-traceability.ts", () => {
		assert.equal(source.includes("requirements-traceability.ts"), false);
	});

	it("names requirements/parity.ts as the consumer", () => {
		assert.ok(source.includes("requirements/parity.ts"), "header must name the real consumer");
	});

	it("module surface is still just isTestableFile", async () => {
		const mod = (await import("../checks/file-classification.ts")) as Record<string, unknown>;
		assert.deepEqual([...Object.keys(mod)].sort(), ["isTestableFile"]);
	});
});
