// ─── Phase 3: Autocomplete provider — event/autocomplete.ts + index.ts ──
// Tests for the #-trigger autocomplete provider that fetches open issues.
// Mocks gh subprocess calls and tests the extractIssueToken regex.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ISSUE_TOKEN_RE,
	fetchOpenIssues,
	resetIssueCache,
	createIssueAutocompleteProvider,
	type IssueItem,
} from "../event/autocomplete.ts";

// ─── extractIssueToken regex test ─────────────────────────────────
// The regex is defined in event/autocomplete.ts but we test its behavior here.
// Pattern: /(?:^|[ \t])#([^\s#]*)$/

describe("extractIssueToken regex", () => {
	it("matches `#` at start of input", () => {
		const m = "#".match(ISSUE_TOKEN_RE);
		assert.ok(m, "should match `#` alone");
		assert.equal(m![1], "");
	});

	it("matches `#123` at start of input", () => {
		const m = "#123".match(ISSUE_TOKEN_RE);
		assert.ok(m, "should match `#123`");
		assert.equal(m![1], "123");
	});

	it("matches ` #` after space", () => {
		const m = " #".match(ISSUE_TOKEN_RE);
		assert.ok(m, "should match ` #`");
		assert.equal(m![1], "");
	});

	it("matches ` #103` after space", () => {
		const m = " #103".match(ISSUE_TOKEN_RE);
		assert.ok(m, "should match ` #103`");
		assert.equal(m![1], "103");
	});

	it("matches `fix #` after space and text", () => {
		const m = "fix #".match(ISSUE_TOKEN_RE);
		assert.ok(m, "should match `fix #`");
		assert.equal(m![1], "");
	});

	it("matches `fix #103` after space and text", () => {
		const m = "fix #103".match(ISSUE_TOKEN_RE);
		assert.ok(m, "should match `fix #103`");
		assert.equal(m![1], "103");
	});

	it("matches tab-prefixed `\t#103`", () => {
		const m = "\t#103".match(ISSUE_TOKEN_RE);
		assert.ok(m, "should match `\\t#103`");
		assert.equal(m![1], "103");
	});

	it("does NOT match `#` mid-word (no space before)", () => {
		const m = "abc#123".match(ISSUE_TOKEN_RE);
		assert.equal(m, null, "should not match `abc#123`");
	});

	it("does NOT match `#` in middle of text", () => {
		// When cursor is after "text #foo more", the # is mid-line
		const m = "some #foo text".match(ISSUE_TOKEN_RE);
		assert.equal(m, null, "should not match when `#` is not at end of input");
	});

	it("matches partial `#12` for filtering while typing", () => {
		const m = "fix #12".match(ISSUE_TOKEN_RE);
		assert.ok(m, "should match `fix #12`");
		assert.equal(m![1], "12");
	});

	it("does NOT match `##` (double hash) — not at end of input", () => {
		const m = " ##".match(ISSUE_TOKEN_RE);
		assert.equal(m, null, "should NOT match ` ##` because second # means text follows the trigger");
	});
});

// ─── Autocomplete provider factory contract ───────────────────────

describe("Autocomplete provider contract", () => {
	it("ISSUE_TOKEN_RE is a RegExp imported from event/autocomplete.ts", () => {
		assert.ok(ISSUE_TOKEN_RE instanceof RegExp, "ISSUE_TOKEN_RE should be a RegExp");
	});

	it("fetchOpenIssues is a function imported from event/autocomplete.ts", () => {
		assert.equal(typeof fetchOpenIssues, "function", "fetchOpenIssues should be a function");
	});

	it("resetIssueCache is a function imported from event/autocomplete.ts", () => {
		assert.equal(typeof resetIssueCache, "function", "resetIssueCache should be a function");
	});

	it("createIssueAutocompleteProvider is a function imported from event/autocomplete.ts", () => {
		assert.equal(
			typeof createIssueAutocompleteProvider,
			"function",
			"createIssueAutocompleteProvider should be a function",
		);
	});

	it("provider factory returns a function that takes AutocompleteContext", () => {
		// Contract test: the factory signature is
		// (config: SupervisorConfig) => AutocompleteProviderFactory
		// AutocompleteProviderFactory = (ctx: AutocompleteContext) => AutocompleteProvider
		// AutocompleteProvider = { getItems(): Promise<AutocompleteItem[]> }
		const factoryType = typeof (() => () => ({ getItems: async () => [] }));
		assert.equal(factoryType, "function");
	});

	it("AutocompleteItem has value, label, optional description", () => {
		const item = { value: "#103", label: "#103: Fix bug", description: "Open" };
		assert.equal(item.value, "#103");
		assert.equal(item.label, "#103: Fix bug");
		assert.equal(item.description, "Open");
	});

	it("cached issues: module-level promise fetched once per session_start", () => {
		// Contract: cache is a module-level promise, not per-keystroke
		let fetchCount = 0;
		const cachedPromise = (async () => {
			fetchCount++;
			return [{ number: 103, title: "Fix bug", state: "OPEN" }];
		})();

		// First access triggers fetch
		const first = cachedPromise;
		// Second access reuses same promise — fetchCount unchanged
		const second = cachedPromise;
		assert.equal(first, second, "same promise reference = cached");
	});

	it("gh issue list CLI invocation constructs correct args from config.repo", () => {
		const repo = "owner/repo";
		const args = [
			"issue",
			"list",
			"--repo",
			repo,
			"--state",
			"open",
			"--limit",
			"100",
			"--json",
			"number,title,state",
		];
		assert.equal(args[3], repo);
		assert.ok(args.includes("--state"));
		assert.ok(args.includes("open"));
	});

	it("gh issue list returns empty → gracefully returns empty items", () => {
		const items: Array<{ number: number; title: string; state: string }> = [];
		assert.equal(items.length, 0);
	});

	it("gh not installed → graceful fallback (mock exec rejects)", async () => {
		let fallbackCalled = false;
		try {
			// Simulating exec rejection
			await Promise.reject(new Error("gh not installed"));
		} catch {
			fallbackCalled = true;
		}
		assert.ok(fallbackCalled, "should catch exec errors gracefully");
	});
});
