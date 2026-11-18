// ─── Adapter Base (issue #2098) ──────────────────────────────────
// Shared wiring for the Octokit sub-adapters: the transport handle, the
// scoped debug logger, and the one repo-slug parser.
//
// Sub-adapters inherit the constructor (and therefore the transport type) by
// declaring none of their own, so `github-transport.ts` is imported here and
// by the composition root only.

import type { DebugLogger } from "../lib/debug.ts";
import type { GitHubTransport } from "./github-transport.ts";

export abstract class RepoAdapterBase {
	protected readonly transport: GitHubTransport;
	protected readonly log: DebugLogger;

	constructor(transport: GitHubTransport, log: DebugLogger) {
		this.transport = transport;
		this.log = log;
	}

	/**
	 * Split an `owner/name` slug once, for every REST/GraphQL method that takes
	 * one. Adapter-private: use cases never see the split. A missing segment is
	 * a caller bug, so it fails fast before any request is issued.
	 */
	protected parseRepo(repo: string): { owner: string; name: string } {
		const [owner, name] = repo.split("/");
		if (!owner || !name) throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);
		return { owner, name };
	}
}
