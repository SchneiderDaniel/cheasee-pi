// ─── Tests: OctokitClient — 404 interpretation (issue #1893) ─────
// getIssue() and getIssueWithComments() must classify "not found" with a
// single predicate and agree with each other, for every error shape. Only
// the public methods are exercised: isNotFound stays unexported.
//
// Fixtures live in ../helper/octokit-fixtures.mts.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
	MOCK_ISSUE,
	NOT_FOUND_ERRORS,
	OTHER_ERRORS,
	clientWithIssues,
} from "../helper/octokit-fixtures.mts";

// ═══════════════════════════════════════════════════════════════════════
// getIssue / getIssueWithComments — 404 interpretation (issue #1893)
// The "not found" definition is a single predicate; both methods must agree.
// Exercised only through the public methods (isNotFound stays unexported).
// ═══════════════════════════════════════════════════════════════════════

describe("OctokitClient.getIssue — 404 interpretation", () => {
	it("resolves null for 404-shaped errors", async () => {
		for (const err of NOT_FOUND_ERRORS) {
			const client = clientWithIssues({
				get: mock.fn(async () => {
					throw err;
				}),
			});
			assert.equal(
				await client.getIssue(1, "owner/repo"),
				null,
				`should resolve null for ${JSON.stringify(err)}`,
			);
		}
	});

	it("rethrows every non-404 error unchanged", async () => {
		for (const err of OTHER_ERRORS) {
			const client = clientWithIssues({
				get: mock.fn(async () => {
					throw err;
				}),
			});
			await assert.rejects(
				() => client.getIssue(1, "owner/repo"),
				(e: unknown) => e === err,
				`should rethrow the exact value for ${String(err)}`,
			);
		}
	});

	it("maps issue data on the happy path", async () => {
		const client = clientWithIssues({ get: mock.fn(async () => ({ data: MOCK_ISSUE })) });
		assert.deepEqual(await client.getIssue(1, "owner/repo"), {
			number: 42,
			title: "Title",
			body: "Body",
			author: { login: "alice" },
		});
	});

	it("normalizes falsy title/body and missing user to undefined", async () => {
		const client = clientWithIssues({
			get: mock.fn(async () => ({ data: { number: 7, title: "", body: null } })),
		});
		assert.deepEqual(await client.getIssue(1, "owner/repo"), {
			number: 7,
			title: undefined,
			body: undefined,
			author: undefined,
		});
	});

	it("invalid repo format throws before any request", async () => {
		const get = mock.fn(async () => ({ data: MOCK_ISSUE }));
		const client = clientWithIssues({ get });
		await assert.rejects(() => client.getIssue(1, "invalid"), /Invalid repo format/);
		assert.equal(get.mock.callCount(), 0, "must not call the API for an invalid repo");
	});
});

describe("OctokitClient.getIssueWithComments — 404 interpretation", () => {
	it("resolves null for 404-shaped errors from either call", async () => {
		for (const err of NOT_FOUND_ERRORS) {
			const issueClient = clientWithIssues({
				get: mock.fn(async () => ({ data: MOCK_ISSUE })),
				listComments: mock.fn(async () => {
					throw err;
				}),
			});
			assert.equal(
				await issueClient.getIssueWithComments(1, "owner/repo"),
				null,
				`listComments 404 (${JSON.stringify(err)}) → null`,
			);

			const commentClient = clientWithIssues({
				get: mock.fn(async () => {
					throw err;
				}),
				listComments: mock.fn(async () => ({ data: [] })),
			});
			assert.equal(
				await commentClient.getIssueWithComments(1, "owner/repo"),
				null,
				`issues.get 404 (${JSON.stringify(err)}) → null`,
			);
		}
	});

	it("rethrows every non-404 error unchanged", async () => {
		for (const err of OTHER_ERRORS) {
			const client = clientWithIssues({
				get: mock.fn(async () => {
					throw err;
				}),
				listComments: mock.fn(async () => ({ data: [] })),
			});
			await assert.rejects(
				() => client.getIssueWithComments(1, "owner/repo"),
				(e: unknown) => e === err,
			);
		}
	});

	it("maps issue + comments on the happy path", async () => {
		const client = clientWithIssues({
			get: mock.fn(async () => ({ data: MOCK_ISSUE })),
			listComments: mock.fn(async () => ({
				data: [{ user: { login: "bob" }, body: "hi" }, { body: "" }],
			})),
		});
		assert.deepEqual(await client.getIssueWithComments(1, "owner/repo"), {
			number: 42,
			title: "Title",
			body: "Body",
			author: { login: "alice" },
			comments: [
				{ author: { login: "bob" }, body: "hi", id: undefined },
				{ author: undefined, body: undefined, id: undefined },
			],
		});
	});

	it("invalid repo format throws", async () => {
		const client = clientWithIssues({ get: mock.fn(async () => ({ data: MOCK_ISSUE })) });
		await assert.rejects(() => client.getIssueWithComments(1, "invalid"), /Invalid repo format/);
	});
});

describe("OctokitClient — cross-method 404 symmetry (issue #1893)", () => {
	it("getIssue and getIssueWithComments never disagree about 'not found'", async () => {
		for (const err of [...NOT_FOUND_ERRORS, ...OTHER_ERRORS]) {
			const issueClient = clientWithIssues({
				get: mock.fn(async () => {
					throw err;
				}),
				listComments: mock.fn(async () => ({ data: [] })),
			});
			const commentClient = clientWithIssues({
				get: mock.fn(async () => {
					throw err;
				}),
				listComments: mock.fn(async () => ({ data: [] })),
			});
			const outcome = async (p: Promise<unknown>): Promise<string> => {
				try {
					await p;
					return "resolved";
				} catch {
					return "rejected";
				}
			};
			assert.equal(
				await outcome(issueClient.getIssue(1, "owner/repo")),
				await outcome(commentClient.getIssueWithComments(1, "owner/repo")),
				`methods disagreed about ${String(err)}`,
			);
		}
	});
});
