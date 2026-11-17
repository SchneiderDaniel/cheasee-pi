// ─── Tests: github/github-transport.ts (issue #2098) ─────────────
// Phase 1 — one construction site owns auth for BOTH handles, and the
// GraphQL error envelope stays exactly as the pre-split adapter produced it.
//
// The X-GitHub-Api-Version header is deliberately NOT asserted on the wire:
// Octokit v22 ignores the constructor `headers` option, so pinning it would
// force an unrequested behavior change. Token propagation is asserted instead.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createGitHubTransport, type GitHubTransport } from "../../github/github-transport.ts";

// ─── fetch stub ───────────────────────────────────────────────────

interface RecordedRequest {
	url: string;
	method: string | undefined;
	headers: Record<string, string>;
	body: unknown;
}

const realFetch = globalThis.fetch;
let recorded: RecordedRequest[] = [];

function headerBag(raw: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!raw) return out;
	const entries =
		typeof (raw as { entries?: unknown }).entries === "function"
			? Array.from((raw as { entries: () => Iterable<[string, string]> }).entries())
			: Object.entries(raw as Record<string, string>);
	for (const [key, value] of entries) out[String(key).toLowerCase()] = String(value);
	return out;
}

/** Replace global fetch so every request resolves with `payload`. */
function installFetch(payload: unknown): void {
	recorded = [];
	globalThis.fetch = (async (input: unknown, init?: unknown) => {
		const req = (init ?? {}) as { method?: string; headers?: unknown; body?: unknown };
		const url =
			typeof input === "string" ? input : String((input as { url?: string }).url ?? String(input));
		recorded.push({
			url,
			method: req.method,
			headers: headerBag(req.headers),
			body: req.body,
		});
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	recorded = [];
});

// ═══════════════════════════════════════════════════════════════════
// Token propagation — GraphQL + REST both carry the transport's token
// ═══════════════════════════════════════════════════════════════════

describe("GitHubTransport — token propagation", () => {
	it("query() POSTs to the GraphQL endpoint with the token in authorization", async () => {
		installFetch({ data: { viewer: { login: "x" } } });
		const transport = createGitHubTransport("t1");

		const result = await transport.query<{ viewer: { login: string } }>("{ viewer { login } }");

		assert.deepEqual(result, { viewer: { login: "x" } });
		assert.equal(recorded.length, 1);
		assert.equal(recorded[0]!.url, "https://api.github.com/graphql");
		assert.equal(recorded[0]!.method, "POST");
		assert.equal(recorded[0]!.headers.authorization, "token t1");
	});

	it("octokit requests carry the token in authorization", async () => {
		installFetch({ login: "me" });
		const transport = createGitHubTransport("t1");

		const resp = await transport.octokit.request("GET /user");

		assert.deepEqual(resp.data, { login: "me" });
		assert.equal(recorded.length, 1);
		assert.equal(recorded[0]!.url, "https://api.github.com/user");
		assert.equal(recorded[0]!.headers.authorization, "token t1");
	});
});

// ═══════════════════════════════════════════════════════════════════
// GraphQL error envelope — unchanged by the split
// ═══════════════════════════════════════════════════════════════════

describe("GitHubTransport — GraphQL error wrapping", () => {
	it("wraps an errors payload with the preserved envelope and the server message", async () => {
		installFetch({ errors: [{ message: "Something broke badly" }] });
		const transport = createGitHubTransport("t1");

		await assert.rejects(
			() => transport.query("{ viewer { login } }"),
			(err: Error) => {
				assert.ok(
					err.message.startsWith("GitHub GraphQL request failed: "),
					`envelope must be preserved verbatim, got: ${err.message}`,
				);
				assert.ok(
					err.message.includes("Something broke badly"),
					`server message must survive, got: ${err.message}`,
				);
				return true;
			},
		);
	});

	it("wraps a non-Error rejection by string coercion", async () => {
		const transport = fakeGraphqlThrower("boom");
		await assert.rejects(
			() => transport.query("{ viewer { login } }"),
			(err: Error) => err.message === "GitHub GraphQL request failed: boom",
		);
	});

	it("propagates an Error rejection's message", async () => {
		const transport = fakeGraphqlThrower(new Error("network down"));
		await assert.rejects(
			() => transport.query("{ viewer { login } }"),
			(err: Error) => err.message === "GitHub GraphQL request failed: network down",
		);
	});
});

/** Transport whose GraphQL handle throws `thrown` (no network involved). */
function fakeGraphqlThrower(thrown: unknown): GitHubTransport {
	const transport = createGitHubTransport("t1");
	(transport as { graphql: unknown }).graphql = (async () => {
		throw thrown;
	}) as never;
	return transport;
}

// ═══════════════════════════════════════════════════════════════════
// setToken — both handles swap together, never a half-updated pair
// ═══════════════════════════════════════════════════════════════════

describe("GitHubTransport — setToken", () => {
	it("replaces both handles and the next requests carry only the new token", async () => {
		const transport = createGitHubTransport("t1");
		const beforeOctokit = transport.octokit;
		const beforeGraphql = transport.graphql;

		transport.setToken("t2");

		assert.notEqual(transport.octokit, beforeOctokit, "octokit handle must be replaced");
		assert.notEqual(transport.graphql, beforeGraphql, "graphql handle must be replaced");

		installFetch({ data: { viewer: { login: "x" } }, login: "me" });
		await transport.query("{ viewer { login } }");
		await transport.octokit.request("GET /user");

		assert.equal(recorded.length, 2);
		assert.equal(recorded[0]!.headers.authorization, "token t2");
		assert.equal(recorded[1]!.headers.authorization, "token t2");
		for (const req of recorded) {
			assert.ok(
				!String(req.headers.authorization).includes("t1"),
				"no request may still carry the previous token",
			);
		}
	});

	it("returns void and is idempotent", () => {
		const transport = createGitHubTransport("t1");
		const before = transport.octokit;

		const first: void = transport.setToken("t2");
		const second: void = transport.setToken("t2");

		assert.equal(first, undefined);
		assert.equal(second, undefined);
		assert.notEqual(transport.octokit, before);
	});
});
