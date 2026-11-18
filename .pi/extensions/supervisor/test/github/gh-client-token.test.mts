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

// ─── Tests: resolveGitHubToken() — CHEASEE_AUTH_PATH (read-only secret) ──
// The container mounts the host auth.json read-only at CHEASEE_AUTH_PATH and
// does NOT mount ~/.config/gh, so that file is the container's source of truth
// and must beat the gh store the entrypoint seeds into the tmpfs.

describe("resolveGitHubToken() — CHEASEE_AUTH_PATH credential file", () => {
	/** Write an auth.json-shaped secret file and return its path. */
	function writeSecret(body: string): string {
		const dir = mkdtempSync(join(tmpdir(), "gh-tok-secret-"));
		const path = join(dir, "cheasee_auth");
		writeFileSync(path, body);
		return path;
	}

	it("resolves github_token from the file named by CHEASEE_AUTH_PATH", () => {
		const secret = writeSecret(JSON.stringify({ github_token: "gho_secret" }));
		try {
			const home = mkdtempSync(join(tmpdir(), "gh-tok-secret-home-"));
			try {
				assert.equal(
					resolveGitHubToken({ home, env: { CHEASEE_AUTH_PATH: secret } }),
					"gho_secret",
				);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		} finally {
			rmSync(join(secret, ".."), { recursive: true, force: true });
		}
	});

	it("GH_TOKEN wins over the secret file", () => {
		const secret = writeSecret(JSON.stringify({ github_token: "gho_secret" }));
		try {
			assert.equal(
				resolveGitHubToken({
					home: tmpdir(),
					env: { GH_TOKEN: "gho_env", CHEASEE_AUTH_PATH: secret },
				}),
				"gho_env",
			);
		} finally {
			rmSync(join(secret, ".."), { recursive: true, force: true });
		}
	});

	it("the secret file wins over hosts.yml", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-tok-secret-both-"));
		const secret = writeSecret(JSON.stringify({ github_token: "gho_secret" }));
		try {
			writeHosts(home, "gho_hosts");
			assert.equal(
				resolveGitHubToken({ home, env: { CHEASEE_AUTH_PATH: secret } }),
				"gho_secret",
				"auth.json is the single source of truth in the container",
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(join(secret, ".."), { recursive: true, force: true });
		}
	});

	it("falls back to hosts.yml when the secret file is malformed JSON", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-tok-secret-bad-"));
		const secret = writeSecret("{not json");
		try {
			writeHosts(home, "gho_hosts");
			assert.equal(resolveGitHubToken({ home, env: { CHEASEE_AUTH_PATH: secret } }), "gho_hosts");
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(join(secret, ".."), { recursive: true, force: true });
		}
	});

	it("falls back when CHEASEE_AUTH_PATH points at a missing file", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-tok-secret-missing-"));
		try {
			writeHosts(home, "gho_hosts");
			assert.equal(
				resolveGitHubToken({
					home,
					env: { CHEASEE_AUTH_PATH: join(home, "no-such-secret") },
				}),
				"gho_hosts",
			);
			assert.equal(
				resolveGitHubToken({ home: tmpdir(), env: { CHEASEE_AUTH_PATH: "/nope/nope" } }),
				null,
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("falls back when github_token is empty or not a string", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-tok-secret-shape-"));
		try {
			writeHosts(home, "gho_hosts");
			for (const body of [
				JSON.stringify({ github_token: "" }),
				JSON.stringify({ github_token: "   " }),
				JSON.stringify({ github_token: 42 }),
				JSON.stringify({ github_token: { nested: "x" } }),
				JSON.stringify({ github_user: "me" }),
			]) {
				const secret = writeSecret(body);
				try {
					assert.equal(
						resolveGitHubToken({ home, env: { CHEASEE_AUTH_PATH: secret } }),
						"gho_hosts",
						`${body} must fall through to hosts.yml`,
					);
				} finally {
					rmSync(join(secret, ".."), { recursive: true, force: true });
				}
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("ignores CHEASEE_AUTH_PATH when it is unset or blank (existing behavior)", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-tok-secret-unset-"));
		try {
			writeHosts(home, "gho_hosts");
			assert.equal(resolveGitHubToken({ home, env: {} }), "gho_hosts");
			assert.equal(resolveGitHubToken({ home, env: { CHEASEE_AUTH_PATH: "  " } }), "gho_hosts");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
