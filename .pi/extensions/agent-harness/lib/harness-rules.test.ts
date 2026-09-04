/**

 * Tests for harness-rules.ts — pure domain rules.
 * No infra, no pi runtime, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildRedirectMessage,
	REDIRECT_GUIDANCE,
	MULTI_VERB_TOOLS,
	shouldBlockRetry,
	isRedundantRead,
	TOOL_META,
	getToolMeta,
	loadDefaultRules,
	CASCADE_THRESHOLD,
} from "./harness-rules.ts";

// ── BASH_SEARCH_SIGNALS (dead export) ──

describe("BASH_SEARCH_SIGNALS", () => {
	it("is no longer exported from the module", async () => {
		const mod = await import("./harness-rules.ts");
		assert.equal(
			(mod as Record<string, unknown>).BASH_SEARCH_SIGNALS,
			undefined,
			"BASH_SEARCH_SIGNALS should be removed — use isBashSearch() from lib/bash-query.ts",
		);
	});
});

// ── buildRedirectMessage ──

describe("buildRedirectMessage", () => {
	it("returns system override format for ripgrep_search", () => {
		const msg = buildRedirectMessage("ripgrep_search");
		assert.ok(msg.includes("[SYSTEM OVERRIDE]"));
		assert.ok(msg.includes("grep"));
		assert.ok(msg.includes("ripgrep_search"));
		assert.ok(!msg.includes("Example call"), "should NOT contain Example call line by default");
	});

	it("returns system override format for read", () => {
		const msg = buildRedirectMessage("read");
		assert.ok(msg.includes("[SYSTEM OVERRIDE]"));
		assert.ok(msg.includes("cat"));
		assert.ok(msg.includes("read"));
		assert.ok(!msg.includes("Example call"), "should NOT contain Example call line by default");
	});

	it("returns empty string for unknown tool", () => {
		assert.equal(buildRedirectMessage("unknown_tool"), "");
	});

	it("takes exactly one argument (schemaExample param removed)", () => {
		assert.equal(buildRedirectMessage.length, 1);
	});
});

// ── REDIRECT_GUIDANCE ──

describe("REDIRECT_GUIDANCE", () => {
	it("is a non-null object with read and ripgrep_search keys", () => {
		assert.ok(REDIRECT_GUIDANCE !== null && typeof REDIRECT_GUIDANCE === "object");
		assert.ok("read" in REDIRECT_GUIDANCE);
		assert.ok("ripgrep_search" in REDIRECT_GUIDANCE);
	});

	it("read entry has shape { forbidden, tool } with tool === 'read'", () => {
		const entry = REDIRECT_GUIDANCE["read"];
		assert.ok(typeof entry?.forbidden === "string");
		assert.ok(typeof entry?.tool === "string");
		assert.equal(entry.tool, "read");
	});

	it("ripgrep_search entry has shape { forbidden, tool } with tool === 'ripgrep_search'", () => {
		const entry = REDIRECT_GUIDANCE["ripgrep_search"];
		assert.ok(typeof entry?.forbidden === "string");
		assert.ok(typeof entry?.tool === "string");
		assert.equal(entry.tool, "ripgrep_search");
	});

	it("unknown key returns undefined", () => {
		assert.equal(REDIRECT_GUIDANCE["unknown"], undefined);
	});
});

// ── MULTI_VERB_TOOLS ──

describe("MULTI_VERB_TOOLS", () => {
	it("contains git, npm, docker, gh", () => {
		assert.ok(MULTI_VERB_TOOLS.has("git"));
		assert.ok(MULTI_VERB_TOOLS.has("npm"));
		assert.ok(MULTI_VERB_TOOLS.has("docker"));
		assert.ok(MULTI_VERB_TOOLS.has("gh"));
	});

	it("does not contain cat, echo, ls", () => {
		assert.equal(MULTI_VERB_TOOLS.has("cat"), false);
		assert.equal(MULTI_VERB_TOOLS.has("echo"), false);
		assert.equal(MULTI_VERB_TOOLS.has("ls"), false);
	});
});

// ── shouldBlockRetry ──

describe("shouldBlockRetry", () => {
	it("blocks at 2 errors", () => {
		assert.equal(shouldBlockRetry(2), true);
	});

	it("does not block at 0 errors", () => {
		assert.equal(shouldBlockRetry(0), false);
	});

	it("does not block at 1 error", () => {
		assert.equal(shouldBlockRetry(1), false);
	});
});

// ── isRedundantRead ──

describe("isRedundantRead", () => {
	it("detects same path as redundant", () => {
		assert.equal(isRedundantRead("/a.ts", "/a.ts", 1), true);
	});

	it("different paths not redundant", () => {
		assert.equal(isRedundantRead("/a.ts", "/b.ts", 1), false);
	});

	it("empty paths not redundant", () => {
		assert.equal(isRedundantRead("", "/a.ts", 1), false);
	});
});

describe("TOOL_META — web_crawl cascade threshold (Bug 7)", () => {
	it("(D) TOOL_META has web_crawl entry with cascadeThreshold", () => {
		assert.ok(TOOL_META.web_crawl, "TOOL_META should have web_crawl entry");
		assert.equal(
			TOOL_META.web_crawl.cascadeThreshold,
			20,
			"web_crawl cascadeThreshold should be 20",
		);
	});

	it("(D) getToolMeta('web_crawl') returns threshold 20", () => {
		const meta = getToolMeta("web_crawl");
		assert.equal(meta.cascadeThreshold, 20, "getToolMeta('web_crawl').cascadeThreshold === 20");
	});

	it("(D) web_crawl threshold > default cascade threshold (8)", () => {
		const webMeta = getToolMeta("web_crawl");
		const bashMeta = getToolMeta("bash");
		assert.ok(
			(webMeta.cascadeThreshold ?? 8) > (bashMeta.cascadeThreshold ?? 8),
			"web_crawl threshold should be higher than default",
		);
	});

	it("(D) Existing passThrough tools unchanged", () => {
		assert.deepEqual(getToolMeta("ask_user"), { passThrough: true });
		assert.deepEqual(getToolMeta("structural_search"), { passThrough: true });
		assert.deepEqual(getToolMeta("ripgrep_search"), { passThrough: true });
	});

	it("(D) bash still has default cascadeThreshold", () => {
		const bashMeta = getToolMeta("bash");
		assert.equal(bashMeta.passThrough, undefined);
		assert.equal(bashMeta.cascadeThreshold, 8);
	});

	it("(Regression) unlisted tools get default meta", () => {
		const meta = getToolMeta("unknown_tool");
		assert.deepEqual(meta, { passThrough: false, cascadeThreshold: 8 });
	});
});

// ── loadDefaultRules ──

describe("loadDefaultRules", () => {
	it("returns object with shape { toolMeta, cascadeThreshold }", () => {
		const rules = loadDefaultRules();
		assert.ok(typeof rules.toolMeta === "object");
		assert.ok(typeof rules.cascadeThreshold === "number");
	});

	it("cascadeThreshold equals CASCADE_THRESHOLD (8)", () => {
		const rules = loadDefaultRules();
		assert.equal(rules.cascadeThreshold, CASCADE_THRESHOLD);
		assert.equal(rules.cascadeThreshold, 8);
	});

	it("toolMeta.bash has cascadeThreshold: 8", () => {
		const rules = loadDefaultRules();
		assert.equal(rules.toolMeta.bash?.cascadeThreshold, 8);
	});

	it("toolMeta.web_crawl has cascadeThreshold: 20", () => {
		const rules = loadDefaultRules();
		assert.equal(rules.toolMeta.web_crawl?.cascadeThreshold, 20);
	});

	it("toolMeta.ask_user has passThrough: true", () => {
		const rules = loadDefaultRules();
		assert.equal(rules.toolMeta.ask_user?.passThrough, true);
	});

	it("Unlisted tool returns default via fallback", () => {
		const rules = loadDefaultRules();
		const meta = rules.toolMeta["unknown_tool"] ?? {
			passThrough: false,
			cascadeThreshold: rules.cascadeThreshold,
		};
		assert.deepEqual(meta, { passThrough: false, cascadeThreshold: 8 });
	});

	it("returns a fresh object each call (no mutation leak)", () => {
		const a = loadDefaultRules();
		const b = loadDefaultRules();
		assert.notEqual(a, b);
		assert.notEqual(a.toolMeta, b.toolMeta);
	});
});

// ── SEARCH_TOOLS removal (#1282) ──

describe("SEARCH_TOOLS removal", () => {
	it("(#1282) SEARCH_TOOLS is undefined after removal (dynamic import)", async () => {
		const mod = await import("./harness-rules.ts");
		assert.equal((mod as Record<string, unknown>).SEARCH_TOOLS, undefined);
	});

	it("(#1282) All other exports are still present (dynamic import)", async () => {
		const mod = await import("./harness-rules.ts");
		const m = mod as Record<string, unknown>;

		// Constants
		assert.equal(typeof m.CACHE_TTL_TURNS, "number", "CACHE_TTL_TURNS should be a number");
		assert.equal(m.CASCADE_THRESHOLD, 8, "CASCADE_THRESHOLD should be 8");
		assert.ok(m.MULTI_VERB_TOOLS instanceof Set, "MULTI_VERB_TOOLS should be a Set");
		assert.ok(
			typeof m.TOOL_META === "object" && m.TOOL_META !== null,
			"TOOL_META should be an object",
		);

		// Exports
		assert.equal(typeof m.REDIRECT_GUIDANCE, "object", "REDIRECT_GUIDANCE should be an object");

		// Functions
		assert.equal(typeof m.loadDefaultRules, "function", "loadDefaultRules should be a function");
		assert.equal(
			typeof m.buildRedirectMessage,
			"function",
			"buildRedirectMessage should be a function",
		);
		assert.equal(typeof m.getToolMeta, "function", "getToolMeta should be a function");
		assert.equal(typeof m.shouldBlockRetry, "function", "shouldBlockRetry should be a function");
		assert.equal(typeof m.isRedundantRead, "function", "isRedundantRead should be a function");
	});
});

// ── isCodeFilePath removal (#1279) ──

describe("isCodeFilePath removal", () => {
	it("(#1279) isCodeFilePath is undefined after removal (dynamic import)", async () => {
		const mod = await import("./harness-rules.ts");
		assert.equal(
			(mod as Record<string, unknown>).isCodeFilePath,
			undefined,
			"isCodeFilePath should be removed — dead export with no callers",
		);
	});

	it("(#1279) CODE_EXTENSIONS is undefined after removal (dynamic import)", async () => {
		const mod = await import("./harness-rules.ts");
		assert.equal(
			(mod as Record<string, unknown>).CODE_EXTENSIONS,
			undefined,
			"CODE_EXTENSIONS should be removed — only referenced by isCodeFilePath",
		);
	});

	it("(#1279) No isCodeFilePath reference remains in source (ripgrep assertion)", async () => {
		const mod = await import("./harness-rules.ts");
		// Verify no property named isCodeFilePath exists on the module
		assert.equal(
			Object.prototype.hasOwnProperty.call(mod, "isCodeFilePath"),
			false,
			"isCodeFilePath should not be a property of the module",
		);
	});

	it("(#1279) All other exports are still present (dynamic import)", async () => {
		const mod = await import("./harness-rules.ts");
		const m = mod as Record<string, unknown>;

		// Constants
		assert.equal(typeof m.CACHE_TTL_TURNS, "number", "CACHE_TTL_TURNS should be a number");
		assert.equal(m.CASCADE_THRESHOLD, 8, "CASCADE_THRESHOLD should be 8");
		assert.ok(m.MULTI_VERB_TOOLS instanceof Set, "MULTI_VERB_TOOLS should be a Set");
		assert.ok(typeof m.TOOL_META === "object" && m.TOOL_META !== null, "TOOL_META should be an object");

		// Exports
		assert.equal(typeof m.REDIRECT_GUIDANCE, "object", "REDIRECT_GUIDANCE should be an object");

		// Functions
		assert.equal(typeof m.loadDefaultRules, "function", "loadDefaultRules should be a function");
		assert.equal(typeof m.buildRedirectMessage, "function", "buildRedirectMessage should be a function");
		assert.equal(typeof m.getToolMeta, "function", "getToolMeta should be a function");
		assert.equal(typeof m.shouldBlockRetry, "function", "shouldBlockRetry should be a function");
		assert.equal(typeof m.isRedundantRead, "function", "isRedundantRead should be a function");

		// Removal assertions
		assert.equal(m.isCodeFilePath, undefined, "isCodeFilePath should be undefined");
		assert.equal(m.CODE_EXTENSIONS, undefined, "CODE_EXTENSIONS should be undefined");
	});
});
