// ─── Bash sub-key derivation (issue #2033 split) ────────────────────
// `getBashSubKey` moved out of `agent-harness.ts` into `lib/bash-subkey.ts`
// and is re-exported from the harness. The sub-key is the cascade counter's
// composite identity, so the multi-verb/single-verb distinction is pinned here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBashSubKey } from "../lib/bash-subkey.ts";
import { getBashSubKey as fromHarness } from "../agent-harness.ts";

describe("getBashSubKey", () => {
	it("keeps two tokens for a multi-verb CLI", () => {
		assert.equal(getBashSubKey("git status -s"), "git status");
		assert.equal(getBashSubKey("npm run build"), "npm run");
		assert.equal(getBashSubKey("docker compose up"), "docker compose");
	});

	it("keeps one token for a single-verb command", () => {
		assert.equal(getBashSubKey("cat x"), "cat");
		assert.equal(getBashSubKey("ls -la"), "ls");
	});

	it("strips a `cd <path> &&` navigation prefix", () => {
		assert.equal(getBashSubKey("cd /x && npm test"), "npm test");
	});

	it("treats a bare cd as the command", () => {
		assert.equal(getBashSubKey("cd /x"), "cd");
	});

	it("returns undefined for blank input", () => {
		assert.equal(getBashSubKey("   "), undefined);
		assert.equal(getBashSubKey(""), undefined);
	});

	it("is the same function the harness re-exports", () => {
		assert.equal(fromHarness, getBashSubKey);
	});
});
