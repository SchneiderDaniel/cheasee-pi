// ─── Tests: github/gh-client.ts — token resolution policy ─────────
// detectTokenClass() (remediation hint keying) and resolveGitHubToken()
// (the single resolution policy). Pure credential-store reads: no process
// spawn, no exec mock. The CLI wrappers that consume the resolved token
// are covered by gh-client.test.mts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTokenClass, resolveGitHubToken } from "../../github/gh-client.ts";
import { writeHosts } from "../helper/gh-client-fixtures.mts";

// ─── Tests: detectTokenClass() ───────────────────────────────────

describe("detectTokenClass() — remediation hint keying", () => {
	it("returns 'cheasee-pi' when auth.json holds a github_token", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-class-pi-"));
		try {
			mkdirSync(join(home, ".config", "cheasee-pi"), { recursive: true });
			writeFileSync(
				join(home, ".config", "cheasee-pi", "auth.json"),
				JSON.stringify({ github_token: "gho_init_minted", github_user: "me" }),
			);
			assert.equal(detectTokenClass(home), "cheasee-pi");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("returns 'gh' when gh hosts.yml holds an oauth_token", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-class-gh-"));
		try {
			mkdirSync(join(home, ".config", "gh"), { recursive: true });
			const yml = [
				"github.com:",
				"    users:",
				"        octocat:",
				"            oauth_token: gho_gh_minted",
				"    oauth_token: gho_gh_minted",
			].join("\n");
			writeFileSync(join(home, ".config", "gh", "hosts.yml"), yml);
			assert.equal(detectTokenClass(home), "gh");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("returns 'unknown' when neither credential store exists", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-class-unk-"));
		try {
			assert.equal(detectTokenClass(home), "unknown");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("auth.json wins over gh hosts.yml when both exist (init token re-imported into gh)", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-class-both-"));
		try {
			mkdirSync(join(home, ".config", "cheasee-pi"), { recursive: true });
			writeFileSync(
				join(home, ".config", "cheasee-pi", "auth.json"),
				JSON.stringify({ github_token: "gho_init_minted" }),
			);
			mkdirSync(join(home, ".config", "gh"), { recursive: true });
			writeFileSync(
				join(home, ".config", "gh", "hosts.yml"),
				"github.com:\n    oauth_token: gho_gh_minted\n",
			);
			assert.equal(
				detectTokenClass(home),
				"cheasee-pi",
				"entrypoint re-import makes gh hold the init token",
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

// ─── Tests: resolveGitHubToken() — one resolution policy ──────────

describe("resolveGitHubToken() — single resolution policy", () => {
	it("prefers GH_TOKEN over hosts.yml", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-tok-pref-"));
		try {
			writeHosts(home, "gho_file");
			assert.equal(resolveGitHubToken({ home, env: { GH_TOKEN: "gho_env" } }), "gho_env");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("falls back to hosts.yml oauth_token when GH_TOKEN is unset", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-tok-file-"));
		try {
			writeHosts(home, "gho_file");
			assert.equal(resolveGitHubToken({ home, env: {} }), "gho_file");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("trims leading/trailing whitespace from GH_TOKEN", () => {
		assert.equal(resolveGitHubToken({ env: { GH_TOKEN: "  gho_pad  " } }), "gho_pad");
	});

	it("returns null when neither source exists", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-tok-none-"));
		try {
			assert.equal(resolveGitHubToken({ home, env: {} }), null);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("returns null when home has no .config/gh/hosts.yml", () => {
		assert.equal(resolveGitHubToken({ home: tmpdir(), env: {} }), null);
	});

	it("returns null when hosts.yml has no oauth_token line", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-tok-noline-"));
		try {
			mkdirSync(join(home, ".config", "gh"), { recursive: true });
			writeFileSync(
				join(home, ".config", "gh", "hosts.yml"),
				"github.com:\n    users:\n        octocat: {}\n",
			);
			assert.equal(resolveGitHubToken({ home, env: {} }), null);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("treats whitespace-only GH_TOKEN as unset and falls through to hosts.yml", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-tok-blank-"));
		try {
			writeHosts(home, "gho_file");
			assert.equal(resolveGitHubToken({ home, env: { GH_TOKEN: "   " } }), "gho_file");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("does not poison a later successful call (no module cache of null)", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-tok-poison-"));
		try {
			assert.equal(resolveGitHubToken({ home, env: {} }), null, "first call: no credential");
			writeHosts(home, "gho_file");
			assert.equal(
				resolveGitHubToken({ home, env: {} }),
				"gho_file",
				"second call sees the newly written credential — null was not cached",
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
