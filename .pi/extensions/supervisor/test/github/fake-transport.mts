// ─── Fake GitHubTransport for adapter tests (issue #2098) ─────────
// Sub-adapters read `transport.octokit` and call `transport.query` per
// request (no cached handles), so every fake is a plain mutable object a
// test can rewrite mid-flight. Cast at the boundary — the fake carries only
// the members the adapter under test actually touches.

import type { DebugLogger } from "../../lib/debug.ts";
import type { GitHubTransport } from "../../github/github-transport.ts";

export interface FakeTransportOverrides {
	octokit?: Record<string, unknown>;
	graphql?: unknown;
	query?: (query: string) => Promise<unknown>;
	setToken?: (token: string) => void;
}

/** Build a transport fake from the pieces the test needs. */
export function fakeTransport(overrides: FakeTransportOverrides = {}): GitHubTransport {
	return {
		octokit: overrides.octokit ?? {},
		graphql: overrides.graphql ?? {},
		query: overrides.query ?? (async () => ({})),
		setToken: overrides.setToken ?? (() => {}),
	} as unknown as GitHubTransport;
}

/** Silent DebugLogger double. */
export function createMockLogger(): DebugLogger {
	const logger: DebugLogger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => logger,
		getSessionId: () => "",
		getLogPath: () => "",
	};
	return logger;
}
