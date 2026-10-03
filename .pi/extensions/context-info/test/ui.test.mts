/**
 * Tests for .pi/extensions/context-info/ui.ts — the derive-only UI port/URL
 * resolver (parity copy of cmd/cheasee-pi/identity.go uiHostPort).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/ui.test.mts
 */

import assert from "node:assert";
import { execSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fnv32 } from "../codeflow.ts";
import { uiHostPort, uiPortFromSlug, uiUrl } from "../ui.ts";

// ── Fixtures ────────────────────────────────────

/** Temp workspace root with an optional cheasee-settings.json (always written
 * — the file IS the workspace marker; `{}` when not specified). */
function makeWorkspace(settingsContent?: string): { root: string; parent: string } {
	const parent = mkdtempSync(join(tmpdir(), "ui-test-"));
	const root = join(parent, "ws");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "cheasee-settings.json"), settingsContent ?? "{}");
	return { root, parent };
}

/** Creates the sibling <parent>/.bare bare clone with a remote URL. */
function makeBareWithRemote(parent: string, url: string): void {
	const bare = join(parent, ".bare");
	mkdirSync(bare, { recursive: true });
	execSync(`git --git-dir "${bare}" init --bare`, { stdio: "ignore" });
	execSync(`git --git-dir "${bare}" config remote.origin.url "${url}"`, { stdio: "ignore" });
}

/** Removes a process.env.PI_UI_PORT set by a test, in all exits. */
function withEnv(port: string | undefined, fn: () => Promise<void>): Promise<void> {
	const saved = process.env.PI_UI_PORT;
	return (async () => {
		try {
			if (port === undefined) delete process.env.PI_UI_PORT;
			else process.env.PI_UI_PORT = port;
			await fn();
		} finally {
			if (saved === undefined) delete process.env.PI_UI_PORT;
			else process.env.PI_UI_PORT = saved;
		}
	})();
}

/** Sets/clears the CLI failure marker (CHEASEE_UI_PORT_UNRESOLVED) for fn. */
function withUnresolved(flag: string | undefined, fn: () => Promise<void>): Promise<void> {
	const saved = process.env.CHEASEE_UI_PORT_UNRESOLVED;
	return (async () => {
		try {
			if (flag === undefined) delete process.env.CHEASEE_UI_PORT_UNRESOLVED;
			else process.env.CHEASEE_UI_PORT_UNRESOLVED = flag;
			await fn();
		} finally {
			if (saved === undefined) delete process.env.CHEASEE_UI_PORT_UNRESOLVED;
			else process.env.CHEASEE_UI_PORT_UNRESOLVED = saved;
		}
	})();
}

afterEach(() => {
	delete process.env.PI_UI_PORT;
	delete process.env.CHEASEE_UI_PORT_UNRESOLVED;
});

// ── Entity: pure derivation ─────────────────────

describe("uiPortFromSlug", () => {
	it("derived port for slug schneiderdaniel-cheasee-pi equals 9968", () => {
		const slug = "schneiderdaniel-cheasee-pi";
		assert.strictEqual(uiPortFromSlug(slug), 9500 + (fnv32(slug) % 1024));
		assert.strictEqual(uiPortFromSlug(slug), 9968);
	});

	it("port always lands in [9500, 10523] inclusive for arbitrary slugs", () => {
		const slugs = ["", "a", "repo-alpha", "schneiderdaniel-cheasee-pi", "x".repeat(200)];
		for (const slug of slugs) {
			const port = uiPortFromSlug(slug);
			assert.ok(port >= 9500 && port <= 10523, `port ${port} for slug ${JSON.stringify(slug)} out of range`);
		}
	});
});

// ── Adapter: precedence + I/O ───────────────────

describe("uiHostPort", () => {
	it("precedence: env PI_UI_PORT (CLI-forwarded bound port) wins over settings and derivation", async () => {
		const { root } = makeWorkspace(`{"docker":{"uiPort":"9600"}}`);
		await withEnv("9700", async () => {
			assert.strictEqual(await uiHostPort(root), "9700");
		});
	});

	it("cross-layer parity: forwarded PI_UI_PORT=9713 beats stale settings docker.uiPort=9600", async () => {
		// Mirrors resolveUIHostPort's bound-first resolution: the CLI forwards
		// the port the sidecar actually published (9713) while the settings file
		// still names 9600. The footer link must match the printed `ℹ UI:` hint.
		const { root } = makeWorkspace(`{"docker":{"uiPort":"9600"}}`);
		await withEnv("9713", async () => {
			assert.strictEqual(await uiHostPort(root), "9713");
			assert.strictEqual(await uiUrl(root), "http://127.0.0.1:9713");
		});
	});

	it("precedence: env PI_UI_PORT wins over derivation", async () => {
		const { root } = makeWorkspace();
		await withEnv("9700", async () => {
			assert.strictEqual(await uiHostPort(root), "9700");
		});
	});

	it("derived port used when settings and env are absent", async () => {
		const { root, parent } = makeWorkspace();
		makeBareWithRemote(parent, "git@github.com:alice/foo.git");
		await withEnv(undefined, async () => {
			assert.strictEqual(await uiHostPort(root), String(uiPortFromSlug("alice-foo")));
		});
	});

	it("malformed cheasee-settings.json falls through to env/derived without throwing", async () => {
		const { root } = makeWorkspace(`{not valid json`);
		await withEnv("9700", async () => {
			assert.strictEqual(await uiHostPort(root), "9700");
		});
		await withEnv(undefined, async () => {
			const port = await uiHostPort(root);
			assert.ok(port !== null && Number(port) >= 9500 && Number(port) <= 10523);
		});
	});

	it("settings docker.uiPort: \"\" treated as absent → falls through", async () => {
		const { root } = makeWorkspace(`{"docker":{"uiPort":""}}`);
		await withEnv("9700", async () => {
			assert.strictEqual(await uiHostPort(root), "9700");
		});
	});

	it("CLI resolution failure (marker set, PI_UI_PORT omitted) suppresses the UI link", async () => {
		// Range exhaustion on the host leaves the UI unavailable: the CLI omits
		// PI_UI_PORT and sets CHEASEE_UI_PORT_UNRESOLVED=1. Deriving then would
		// name an occupied port that is not this workspace's UI — the resolver
		// must return null instead.
		const { root } = makeWorkspace(`{"docker":{"uiPort":"9600"}}`);
		await withEnv(undefined, async () => {
			await withUnresolved("1", async () => {
				assert.strictEqual(await uiHostPort(root), null);
				assert.strictEqual(await uiUrl(root), null);
			});
		});
	});

	it("absent PI_UI_PORT still derives (session started outside the CLI)", async () => {
		const { root, parent } = makeWorkspace();
		makeBareWithRemote(parent, "git@github.com:alice/foo.git");
		await withEnv(undefined, async () => {
			assert.strictEqual(await uiHostPort(root), String(uiPortFromSlug("alice-foo")));
		});
	});

	it("invalid forwarded PI_UI_PORT (non-numeric / control chars) → null, never interpolated", async () => {
		const { root } = makeWorkspace();
		for (const bad of ["abc", "0", "65536", "12x", "\u001b]8;;evil\u0007", "-1"]) {
			await withEnv(bad, async () => {
				assert.strictEqual(await uiHostPort(root), null, `port ${JSON.stringify(bad)} must be rejected`);
				assert.strictEqual(await uiUrl(root), null);
			});
		}
	});

	it("invalid settings docker.uiPort (control chars) falls through to a derived valid port", async () => {
		const { root } = makeWorkspace(`{"docker":{"uiPort":"\u001b]8;;evil\u0007"}}`);
		await withEnv(undefined, async () => {
			const port = await uiHostPort(root);
			assert.ok(port !== null && /^[0-9]{1,5}$/.test(port), "settings payload must not reach the URL");
			assert.ok(Number(port) >= 9500 && Number(port) <= 10523);
		});
	});

	it("no workspace marker reachable → null, no throw", async () => {
		const outside = mkdtempSync(join(tmpdir(), "ui-outside-"));
		await withEnv(undefined, async () => {
			assert.strictEqual(await uiHostPort(outside), null);
			assert.strictEqual(await uiUrl(outside), null);
		});
	});

	it("anchors on the workspace root marker, not dirname(cwd)", async () => {
		const { root, parent } = makeWorkspace(`{"docker":{"uiPort":"9600"}}`);
		makeBareWithRemote(parent, "git@github.com:alice/foo.git");
		const deep = join(root, "sub", "deep");
		mkdirSync(deep, { recursive: true });
		await withEnv(undefined, async () => {
			assert.strictEqual(await uiHostPort(deep), "9600");
		});
	});
});

// ── URL shape + purity ──────────────────────────

describe("uiUrl", () => {
	it("produces http://127.0.0.1:<port> with no trailing slash", async () => {
		const { root } = makeWorkspace(`{"docker":{"uiPort":"9600"}}`);
		await withEnv(undefined, async () => {
			assert.strictEqual(await uiUrl(root), "http://127.0.0.1:9600");
		});
	});

	it("never contains localhost", async () => {
		const { root } = makeWorkspace(`{"docker":{"uiPort":"9600"}}`);
		await withEnv(undefined, async () => {
			const url = await uiUrl(root);
			assert.ok(url !== null && !url.includes("localhost"), "UI URL must use the literal IPv4 loopback");
		});
	});

	it("returns no OSC 8 sequence — ANSI wrapping is owned by the footer", async () => {
		const { root } = makeWorkspace(`{"docker":{"uiPort":"9600"}}`);
		await withEnv(undefined, async () => {
			const url = await uiUrl(root);
			assert.ok(url !== null && !url.includes("\x1b]8;;"), "uiUrl must be plain text");
		});
	});

	it("contains no control characters for any resolvable fixture", async () => {
		const { root } = makeWorkspace();
		await withEnv(undefined, async () => {
			const url = await uiUrl(root);
			assert.ok(url !== null && !/[\u0000-\u001f\u007f]/.test(url), "no control chars may reach the OSC 8 target");
		});
	});
});
