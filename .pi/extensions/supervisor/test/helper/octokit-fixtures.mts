// ─── Shared fixtures: OctokitClient suites ────────────────────────
// The mock logger, the issue payload and the 404 predicate's probe values
// are consumed by all three OctokitClient suites, so they are declared
// once here.
//
// Not named `*.test.mts`, so `node --test` never loads it as a suite.

import { OctokitClient } from "../../github/octokit-client.ts";

export function createMockLogger() {
	return {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => createMockLogger(),
	};
}

export const MOCK_ISSUE = Object.freeze({
	number: 42,
	title: "Title",
	body: "Body",
	// Frozen: three suites import this one object, so none may mutate it.
	user: Object.freeze({ login: "alice" }),
});

export function clientWithIssues(issues: Record<string, unknown>): OctokitClient {
	const client = new OctokitClient("fake-token", createMockLogger() as any);
	(client as any).octokit = { issues };
	return client;
}

// Values the client must interpret as "not found".
export const NOT_FOUND_ERRORS: unknown[] = [
	{ status: 404 },
	Object.assign(new Error("Not Found"), { status: 404 }),
];

// Values the client must rethrow untouched.
export const OTHER_ERRORS: unknown[] = [
	{ status: 500 },
	{ status: 403 },
	{ status: "404" }, // string, not number — strict === 404
	new Error("boom"),
	"boom", // non-object throw
	null, // null is not instanceof Object
];
