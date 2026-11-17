// ─── GitHub Transport (issue #2098) ──────────────────────────────
// The single construction site for the Octokit REST client and the GraphQL
// caller, and the single place that knows the token.
//
// Sub-adapters read `transport.octokit` and call `transport.query` per
// request — never a cached handle — so `setToken` can never leave a
// half-updated REST/GraphQL pair behind.

import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";

// Octokit v22 drops unknown constructor headers on some request paths, so this
// is documentation of intent rather than a wire-level guarantee.
const API_VERSION_HEADERS = { "X-GitHub-Api-Version": "2026-03-10" } as const;

export interface GitHubTransport {
	/** REST handle. Replaced wholesale by `setToken`. */
	octokit: Octokit;
	/** GraphQL caller. Replaced wholesale by `setToken`. */
	graphql: typeof graphql;
	/** Run a GraphQL query, wrapping any failure in the stable error envelope. */
	query<T>(query: string): Promise<T>;
	/** Swap the credential on BOTH handles. */
	setToken(token: string): void;
}

export class OctokitTransport implements GitHubTransport {
	octokit!: Octokit;
	graphql!: typeof graphql;

	constructor(token: string) {
		this.setToken(token);
	}

	setToken(token: string): void {
		this.octokit = new Octokit({ auth: token, headers: { ...API_VERSION_HEADERS } });
		this.graphql = graphql.defaults({
			headers: { authorization: `token ${token}` },
		});
	}

	async query<T>(query: string): Promise<T> {
		try {
			return await (this.graphql as (q: string) => Promise<T>)(query);
		} catch (err: unknown) {
			// @octokit/graphql throws GraphqlResponseError on an errors array.
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`GitHub GraphQL request failed: ${msg}`);
		}
	}
}

/** Build a transport for `token`. The only place Octokit is constructed. */
export function createGitHubTransport(token: string): GitHubTransport {
	return new OctokitTransport(token);
}
