/**
 * Tests for .pi/extensions/context-info/codeflow.ts — the derive-only CodeFlow
 * port/URL resolver (parity copy of cmd/cheasee-pi/identity.go codeflowHostPort).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/codeflow.test.mts
 */

import assert from "node:assert";
import { execSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	codeflowHostPort,
	codeflowPortFromSlug,
	codeflowUrl,
	fnv32,
	parseGitRemote,
	readDockerPortSetting,
	repoSlug,
	resolveWorkspaceRoot,
	sanitizeSlug,
	validPort,
} from "../codeflow.ts";
import { makeBareWithRemote, makeWorkspace as makeWorkspaceFor, withEnvVar } from "./helpers.ts";

// ── Fixtures ────────────────────────────────────

/** codeflow-test- workspace fixture bound to this suite's temp prefix. */
const makeWorkspace = (settingsContent?: string) =>
	makeWorkspaceFor("codeflow-test-", settingsContent);
const withEnv = (port: string | undefined, fn: () => Promise<void>) =>
	withEnvVar("CODEFLOW_PORT", port, fn);

afterEach(() => {
	delete process.env.CODEFLOW_PORT;
});

// ── Entity: pure derivation ─────────────────────

describe("fnv32", () => {
	it("matches the canonical FNV-1a vectors (pinned to Go hash/fnv New32a)", () => {
		assert.strictEqual(fnv32(""), 2166136261, "empty input must hash to the offset basis");
		assert.strictEqual(fnv32("a"), 3826002220);
		assert.strictEqual(fnv32("schneiderdaniel-cheasee-pi"), 460574164);
	});

	it("port derivation is deterministic", () => {
		const slug = "schneiderdaniel-cheasee-pi";
		assert.strictEqual(codeflowPortFromSlug(slug), codeflowPortFromSlug(slug));
	});

	it("port always lands in [8470, 9493] inclusive for arbitrary slugs", () => {
		const slugs = [
			"",
			"a",
			"repo-alpha",
			"repo-beta",
			"schneiderdaniel-cheasee-pi",
			"x".repeat(200),
		];
		for (const slug of slugs) {
			const port = codeflowPortFromSlug(slug);
			assert.ok(
				port >= 8470 && port <= 9493,
				`port ${port} for slug ${JSON.stringify(slug)} out of range`,
			);
		}
	});
});

describe("sanitizeSlug", () => {
	it("lowercases, maps non-alphanumerics to '-', trims leading/trailing '-'", () => {
		assert.strictEqual(sanitizeSlug("A_B!C"), "a-b-c");
		assert.strictEqual(sanitizeSlug("MyRepo"), "myrepo");
		assert.strictEqual(sanitizeSlug("-lead-trail-"), "lead-trail");
		assert.strictEqual(sanitizeSlug("-a-"), "a");
		assert.strictEqual(sanitizeSlug(""), "");
	});
});

describe("parseGitRemote", () => {
	it("parses scp-like and https remotes, stripping .git", () => {
		assert.deepStrictEqual(parseGitRemote("git@github.com:owner/repo.git"), {
			owner: "owner",
			repo: "repo",
		});
		assert.deepStrictEqual(parseGitRemote("https://github.com/owner/repo.git"), {
			owner: "owner",
			repo: "repo",
		});
		assert.deepStrictEqual(parseGitRemote("https://github.com/owner/repo"), {
			owner: "owner",
			repo: "repo",
		});
	});

	it("returns null for empty/unparseable input (fallback path)", () => {
		assert.strictEqual(parseGitRemote(""), null);
		assert.strictEqual(parseGitRemote("   "), null);
		assert.strictEqual(parseGitRemote("git@github.com:"), null);
		assert.strictEqual(parseGitRemote("https://github.com/"), null);
	});
});

describe("validPort", () => {
	it("accepts decimal ports 1-65535 and rejects everything else", () => {
		for (const ok of ["1", "80", "9500", "65535"]) assert.strictEqual(validPort(ok), ok);
		for (const bad of [
			"",
			"0",
			"65536",
			"abc",
			"12x",
			"-1",
			"1.5",
			"\u001b]8;;evil\u0007",
			null,
			undefined,
		]) {
			assert.strictEqual(
				validPort(bad as any),
				null,
				`validPort(${JSON.stringify(bad)}) must be null`,
			);
		}
	});
});

describe("readDockerPortSetting", () => {
	it("reads the named docker port key and isolates keys", () => {
		const uiOnly = makeWorkspace(`{"docker":{"uiPort":"9600"}}`);
		assert.strictEqual(readDockerPortSetting(uiOnly.root, "uiPort"), "9600");
		assert.strictEqual(readDockerPortSetting(uiOnly.root, "codeflowPort"), null);
		const codeflowOnly = makeWorkspace(`{"docker":{"codeflowPort":"9100"}}`);
		assert.strictEqual(readDockerPortSetting(codeflowOnly.root, "codeflowPort"), "9100");
		assert.strictEqual(readDockerPortSetting(codeflowOnly.root, "uiPort"), null);
	});

	it("returns null for absent file, malformed JSON and missing docker key", () => {
		const absent = mkdtempSync(join(tmpdir(), "codeflow-absent-"));
		assert.strictEqual(readDockerPortSetting(absent, "codeflowPort"), null);
		assert.strictEqual(
			readDockerPortSetting(makeWorkspace(`{not valid json`).root, "codeflowPort"),
			null,
		);
		assert.strictEqual(
			readDockerPortSetting(makeWorkspace(`{"docker":{}}`).root, "codeflowPort"),
			null,
		);
		assert.strictEqual(readDockerPortSetting(makeWorkspace(`{}`).root, "codeflowPort"), null);
	});

	it("returns null for non-string values and the empty string", () => {
		for (const value of [9100, { port: 1 }, true, null, []] as unknown[]) {
			const { root } = makeWorkspace(JSON.stringify({ docker: { codeflowPort: value } }));
			assert.strictEqual(readDockerPortSetting(root, "codeflowPort"), null, JSON.stringify(value));
		}
		const { root } = makeWorkspace(`{"docker":{"codeflowPort":""}}`);
		assert.strictEqual(readDockerPortSetting(root, "codeflowPort"), null);
	});

	it("blocks control-char payloads before they reach a URL", () => {
		const { root } = makeWorkspace(`{"docker":{"codeflowPort":"\u001b]8;;evil\u0007"}}`);
		assert.strictEqual(readDockerPortSetting(root, "codeflowPort"), null);
	});

	it("accepts boundary ports and rejects out-of-range/non-numeric", () => {
		for (const ok of ["1", "65535"]) {
			const { root } = makeWorkspace(JSON.stringify({ docker: { uiPort: ok } }));
			assert.strictEqual(readDockerPortSetting(root, "uiPort"), ok);
		}
		for (const bad of ["0", "65536", "123456", "1.5", "-1"]) {
			const { root } = makeWorkspace(JSON.stringify({ docker: { uiPort: bad } }));
			assert.strictEqual(readDockerPortSetting(root, "uiPort"), null, bad);
		}
	});
});

// ── Adapter: precedence + I/O ───────────────────

describe("codeflowHostPort", () => {
	it("precedence: env CODEFLOW_PORT (forwarded bound port) wins over settings and derivation", async () => {
		const { root } = makeWorkspace(`{"docker":{"codeflowPort":"9100"}}`);
		await withEnv("9000", async () => {
			assert.strictEqual(await codeflowHostPort(root), "9000");
		});
	});

	it("precedence: settings docker.codeflowPort wins over derivation when env absent", async () => {
		const { root } = makeWorkspace(`{"docker":{"codeflowPort":"9100"}}`);
		await withEnv(undefined, async () => {
			assert.strictEqual(await codeflowHostPort(root), "9100");
		});
	});

	it("precedence: env CODEFLOW_PORT wins over derivation", async () => {
		const { root } = makeWorkspace();
		await withEnv("9000", async () => {
			assert.strictEqual(await codeflowHostPort(root), "9000");
		});
	});

	it("stale docker.codeflowPort + forwarded bound port → env wins (footer matches the printed hint)", async () => {
		// Regression for the audit finding: the sidecar is bound to 9123 while
		// the workspace settings still say 9100; `cheasee-pi start` forwards the
		// bound port via CODEFLOW_PORT, so the resolver must return 9123 or the
		// footer/notify link would point at the stale 9100.
		const { root } = makeWorkspace(`{"docker":{"codeflowPort":"9100"}}`);
		await withEnv("9123", async () => {
			assert.strictEqual(await codeflowHostPort(root), "9123");
			assert.strictEqual(
				await codeflowUrl(root),
				"http://localhost:9123/?repo=local/workspace&run=1",
			);
		});
	});

	it("precedence: derived port used when settings and env are absent", async () => {
		const { root, parent } = makeWorkspace();
		makeBareWithRemote(parent, "git@github.com:alice/foo.git");
		await withEnv(undefined, async () => {
			const expected = String(codeflowPortFromSlug("alice-foo"));
			assert.strictEqual(await codeflowHostPort(root), expected);
		});
	});

	it("malformed cheasee-settings.json falls through to env/derived without throwing", async () => {
		const { root } = makeWorkspace(`{not valid json`);
		await withEnv("9000", async () => {
			assert.strictEqual(await codeflowHostPort(root), "9000");
		});
		await withEnv(undefined, async () => {
			const port = await codeflowHostPort(root);
			assert.ok(port !== null && port >= "8470" && port <= "9493");
		});
	});

	it("invalid forwarded CODEFLOW_PORT (control chars) → null, never interpolated", async () => {
		const { root } = makeWorkspace();
		await withEnv("\u001b]8;;evil\u0007", async () => {
			assert.strictEqual(await codeflowHostPort(root), null);
			assert.strictEqual(await codeflowUrl(root), null);
		});
	});

	it("invalid settings docker.codeflowPort (control chars) falls through to a derived valid port", async () => {
		const { root } = makeWorkspace(`{"docker":{"codeflowPort":"\u001b]8;;evil\u0007"}}`);
		await withEnv(undefined, async () => {
			const port = await codeflowHostPort(root);
			assert.ok(
				port !== null && /^[0-9]{1,5}$/.test(port),
				"settings payload must not reach the URL",
			);
		});
	});

	it("no workspace marker reachable from cwd → null, no throw", async () => {
		const outside = mkdtempSync(join(tmpdir(), "codeflow-outside-"));
		await withEnv(undefined, async () => {
			assert.strictEqual(await codeflowHostPort(outside), null);
			assert.strictEqual(await codeflowUrl(outside), null);
		});
	});

	it("anchors on the workspace root marker, not dirname(cwd)", async () => {
		const { root, parent } = makeWorkspace();
		makeBareWithRemote(parent, "git@github.com:alice/foo.git");
		const deep = join(root, "sub", "deep");
		mkdirSync(deep, { recursive: true });
		await withEnv(undefined, async () => {
			assert.strictEqual(await codeflowHostPort(deep), String(codeflowPortFromSlug("alice-foo")));
		});
	});

	it("sibling .bare missing/unreadable → basename-slug fallback, URL still produced", async () => {
		// .bare exists as a plain dir without a remote.origin.url config.
		const { root, parent } = makeWorkspace();
		mkdirSync(join(parent, ".bare"), { recursive: true });
		await withEnv(undefined, async () => {
			const port = await codeflowHostPort(root);
			const expected = String(codeflowPortFromSlug("ws"));
			assert.strictEqual(port, expected);
		});
	});

	it("repoSlug follows the CLI fallback chain (remote → repo → basename)", async () => {
		const { root, parent } = makeWorkspace();
		makeBareWithRemote(parent, "git@github.com:alice/foo.git");
		assert.strictEqual(await repoSlug(root), "alice-foo");

		// Owner-less remote → repo name only.
		const bareNoOwner = makeWorkspace();
		mkdirSync(join(bareNoOwner.parent, ".bare"), { recursive: true });
		execSync(`git --git-dir "${join(bareNoOwner.parent, ".bare")}" init --bare`, {
			stdio: "ignore",
		});
		execSync(
			`git --git-dir "${join(bareNoOwner.parent, ".bare")}" config remote.origin.url "https://example.com/onlyrepo.git"`,
			{ stdio: "ignore" },
		);
		assert.strictEqual(await repoSlug(bareNoOwner.root), "onlyrepo");
	});

	it("resolveWorkspaceRoot walks up and returns null outside any workspace", () => {
		const { root } = makeWorkspace();
		assert.strictEqual(resolveWorkspaceRoot(join(root, "sub", "deep")), root);
		assert.strictEqual(resolveWorkspaceRoot(mkdtempSync(join(tmpdir(), "codeflow-none-"))), null);
	});
});

// ── URL shape + purity ──────────────────────────

describe("codeflowUrl", () => {
	it("produces the canonical URL shape with the resolved port interpolated", async () => {
		const { root } = makeWorkspace(`{"docker":{"codeflowPort":"8891"}}`);
		await withEnv(undefined, async () => {
			assert.strictEqual(
				await codeflowUrl(root),
				"http://localhost:8891/?repo=local/workspace&run=1",
			);
		});
	});

	it("returns no OSC 8 sequence — ANSI wrapping is owned by the notify site", async () => {
		const { root } = makeWorkspace(`{"docker":{"codeflowPort":"8891"}}`);
		await withEnv(undefined, async () => {
			const url = await codeflowUrl(root);
			assert.ok(url !== null && !url.includes("\x1b]8;;"), "codeflowUrl must be plain text");
		});
	});
});
