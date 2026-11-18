// ─── Tests: github/octokit-issues.ts (issue #2098) ───────────────
// Phase 2 — the issue REST/comment/label contract is unchanged by the
// God-Object split. Construction changed (transport + logger), behavior
// must not.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/github/octokit-issues.test.mts

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OctokitIssues } from "../../github/octokit-issues.ts";
import { readGraph } from "../../../lib/test/source-graph.ts";
import { fakeTransport, createMockLogger } from "./fake-transport.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GITHUB_DIR = join(__dirname, "../../github");

const MOCK_ISSUE = { number: 42, title: "Title", body: "Body", user: { login: "alice" } };

function adapter(issues: Record<string, unknown>): OctokitIssues {
	return new OctokitIssues(fakeTransport({ octokit: { issues } }), createMockLogger());
}

function rootAdapter(octokit: Record<string, unknown>): OctokitIssues {
	return new OctokitIssues(fakeTransport({ octokit }), createMockLogger());
}

function adapterWithQuery(
	issues: Record<string, unknown>,
	query: (q: string) => Promise<unknown>,
): OctokitIssues {
	return new OctokitIssues(fakeTransport({ octokit: { issues }, query }), createMockLogger());
}

const NOT_FOUND_ERRORS: unknown[] = [
	{ status: 404 },
	Object.assign(new Error("Not Found"), { status: 404 }),
];

const OTHER_ERRORS: unknown[] = [
	{ status: 500 },
	{ status: 403 },
	{ status: "404" },
	new Error("boom"),
	"boom",
	null,
];

// ═══════════════════════════════════════════════════════════════════
// getIssue — 404 interpretation (issue #1893)
// ═══════════════════════════════════════════════════════════════════

describe("OctokitIssues.getIssue — 404 interpretation", () => {
	it("resolves null for 404-shaped errors", async () => {
		for (const err of NOT_FOUND_ERRORS) {
			const client = adapter({
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
			const client = adapter({
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
		const client = adapter({ get: mock.fn(async () => ({ data: MOCK_ISSUE })) });
		assert.deepEqual(await client.getIssue(1, "owner/repo"), {
			number: 42,
			title: "Title",
			body: "Body",
			author: { login: "alice" },
		});
	});

	it("normalizes falsy title/body and missing user to undefined", async () => {
		const client = adapter({
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
		const client = adapter({ get });
		await assert.rejects(
			() => client.getIssue(1, "invalid"),
			(err: Error) => err.message === "Invalid repo format: invalid (expected owner/name)",
		);
		assert.equal(get.mock.callCount(), 0, "must not call the API for an invalid repo");
	});
});

// ═══════════════════════════════════════════════════════════════════
// getIssueWithComments — 404 symmetry across both calls (issue #1893)
// ═══════════════════════════════════════════════════════════════════

describe("OctokitIssues.getIssueWithComments — 404 interpretation", () => {
	it("resolves null for 404-shaped errors from either call", async () => {
		for (const err of NOT_FOUND_ERRORS) {
			const issueClient = adapter({
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

			const commentClient = adapter({
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
			const client = adapter({
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
		const client = adapter({
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
		const client = adapter({ get: mock.fn(async () => ({ data: MOCK_ISSUE })) });
		await assert.rejects(() => client.getIssueWithComments(1, "invalid"), /Invalid repo format/);
	});

	it("getIssue and getIssueWithComments never disagree about 'not found'", async () => {
		for (const err of [...NOT_FOUND_ERRORS, ...OTHER_ERRORS]) {
			const client = adapter({
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
				await outcome(client.getIssue(1, "owner/repo")),
				await outcome(client.getIssueWithComments(1, "owner/repo")),
				`methods disagreed about ${String(err)}`,
			);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// closeIssue / postIssueComment
// ═══════════════════════════════════════════════════════════════════

describe("OctokitIssues.closeIssue", () => {
	it("sends state: 'closed' for the parsed owner/name", async () => {
		const update = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		await adapter({ update }).closeIssue(42, "owner/repo");

		assert.equal(update.mock.callCount(), 1);
		const params = update.mock.calls[0]!.arguments[0] as Record<string, unknown>;
		assert.equal(params.owner, "owner");
		assert.equal(params.repo, "repo");
		assert.equal(params.issue_number, 42);
		assert.equal(params.state, "closed");
	});
});

describe("OctokitIssues.postIssueComment", () => {
	it("normalizes literal \\n escapes so markdown headers render (regression #1663)", async () => {
		const createComment = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		await adapter({ createComment }).postIssueComment(
			42,
			"owner/repo",
			"## Audit Rejected\\n\\n### Findings\\n\\n1. **Correctness & Safety**\\n   - **Symptom:** x",
		);

		assert.equal(createComment.mock.callCount(), 1);
		const params = createComment.mock.calls[0]!.arguments[0] as { body: string };
		assert.ok(params.body.includes("\n\n### Findings\n\n1."), "escapes must become newlines");
		assert.ok(!params.body.includes("\\n"), "no literal \\n escapes may remain");
		assert.ok(params.body.startsWith("## Audit Rejected\n"), "markdown header must render");
	});

	it("leaves real newlines untouched", async () => {
		const createComment = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		await adapter({ createComment }).postIssueComment(
			42,
			"owner/repo",
			"## Audit Approved\n\n### Summary\nok",
		);
		const params = createComment.mock.calls[0]!.arguments[0] as { body: string };
		assert.equal(params.body, "## Audit Approved\n\n### Summary\nok");
	});

	it("truncates at 50 000 chars with the exact safety-limit suffix", async () => {
		const createComment = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		await adapter({ createComment }).postIssueComment(42, "owner/repo", "z".repeat(60_000));

		const params = createComment.mock.calls[0]!.arguments[0] as { body: string };
		assert.ok(params.body.startsWith("z".repeat(50_000)), "body must keep the first 50 000 chars");
		assert.ok(
			params.body.endsWith(
				"⚠️ **Comment truncated at 50,000 character safety limit** — a bug likely caused the full agent execution log to be included. Please report this.",
			),
			"truncation suffix must be preserved verbatim",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// issue #2044 — in-place comment update + label CRUD
// ═══════════════════════════════════════════════════════════════════

describe("OctokitIssues.updateIssueComment (issue #2044)", () => {
	it("dispatches a numeric id to the REST updateComment endpoint", async () => {
		const updateComment = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		await adapter({ updateComment }).updateIssueComment(
			"123456",
			"owner/repo",
			"## Audit Rejected\nx",
		);

		assert.equal(updateComment.mock.callCount(), 1);
		const params = updateComment.mock.calls[0]!.arguments[0] as {
			comment_id: number;
			body: string;
		};
		assert.equal(params.comment_id, 123456);
		assert.equal(params.body, "## Audit Rejected\nx");
	});

	it("dispatches an opaque node id to the GraphQL updateIssueComment mutation", async () => {
		const query = mock.fn(async (_q: string) => ({ updateIssueComment: {} }));
		const client = adapterWithQuery({ updateComment: mock.fn() }, query);

		await client.updateIssueComment("IC_kwDOabc", "owner/repo", "## Audit Rejected\nx");

		assert.equal(query.mock.callCount(), 1);
		const mutation = query.mock.calls[0]!.arguments[0] as string;
		assert.ok(mutation.includes("updateIssueComment"), "must use the updateIssueComment mutation");
		assert.ok(mutation.includes("IC_kwDOabc"), "must carry the comment node id");
	});

	it("truncates through the same helper on both dispatch paths", async () => {
		const updateComment = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		const query = mock.fn(async (_q: string) => ({}));
		const client = adapterWithQuery({ updateComment }, query);
		const long = "z".repeat(60_000);

		await client.updateIssueComment("1", "owner/repo", long);
		await client.updateIssueComment("IC_kwDOabc", "owner/repo", long);

		const restBody = (updateComment.mock.calls[0]!.arguments[0] as { body: string }).body;
		const gqlBody = query.mock.calls[0]!.arguments[0] as string;
		assert.ok(restBody.includes("⚠️ **Comment truncated at 50,000 character safety limit**"));
		assert.ok(gqlBody.includes("⚠️ **Comment truncated at 50,000 character safety limit**"));
	});

	it("invalid repo format throws", async () => {
		await assert.rejects(
			() => adapter({}).updateIssueComment("1", "invalid", "x"),
			/Invalid repo format/,
		);
	});
});

describe("OctokitIssues label CRUD (issue #2044)", () => {
	it("getIssueLabels returns label names", async () => {
		const listLabelsOnIssue = mock.fn(async (_params: Record<string, unknown>) => ({
			data: [{ name: "reject-1" }, { name: "bug" }],
		}));
		assert.deepEqual(await adapter({ listLabelsOnIssue }).getIssueLabels(42, "owner/repo"), [
			"reject-1",
			"bug",
		]);
	});

	it("getIssueLabels paginates per_page 100 until a short page", async () => {
		const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: `l${i}` }));
		const listLabelsOnIssue = mock.fn(async (params: Record<string, unknown>) =>
			(params as { page: number }).page === 1 ? { data: fullPage } : { data: [{ name: "tail" }] },
		);
		const labels = await adapter({ listLabelsOnIssue }).getIssueLabels(42, "owner/repo");

		assert.equal(labels.length, 101);
		assert.equal(labels[100], "tail");
		assert.equal(listLabelsOnIssue.mock.callCount(), 2);
		const first = listLabelsOnIssue.mock.calls[0]!.arguments[0] as Record<string, unknown>;
		assert.equal(first.per_page, 100);
	});

	it("addIssueLabel adds without replacing existing labels", async () => {
		const addLabels = mock.fn(async (_params: Record<string, unknown>) => ({ data: {} }));
		await adapter({ addLabels }).addIssueLabel(42, "owner/repo", "reject-2");
		const params = addLabels.mock.calls[0]!.arguments[0] as { labels: string[] };
		assert.deepEqual(params.labels, ["reject-2"]);
	});

	it("removeIssueLabel tolerates a missing label (404)", async () => {
		const removeLabel = mock.fn(async () => {
			throw Object.assign(new Error("Label does not exist"), { status: 404 });
		});
		await adapter({ removeLabel }).removeIssueLabel(42, "owner/repo", "reject-1");
		assert.equal(removeLabel.mock.callCount(), 1);
	});

	it("removeIssueLabel rethrows non-404 errors", async () => {
		const removeLabel = mock.fn(async () => {
			throw Object.assign(new Error("forbidden"), { status: 403 });
		});
		await assert.rejects(
			() => adapter({ removeLabel }).removeIssueLabel(42, "owner/repo", "reject-1"),
			/forbidden/,
		);
	});

	it("deleteIssueComment tolerates a missing comment (404)", async () => {
		const deleteComment = mock.fn(async () => {
			throw Object.assign(new Error("Not Found"), { status: 404 });
		});
		await adapter({ deleteComment }).deleteIssueComment("123", "owner/repo");
		assert.equal(deleteComment.mock.callCount(), 1);
	});

	it("deleteIssueComment rethrows non-404 errors", async () => {
		const deleteComment = mock.fn(async () => {
			throw Object.assign(new Error("forbidden"), { status: 403 });
		});
		await assert.rejects(
			() => adapter({ deleteComment }).deleteIssueComment("123", "owner/repo"),
			/forbidden/,
		);
	});
});

describe("OctokitIssues.listComments (issue #2044 audit finding #4)", () => {
	it("paginates per_page 100 until a short page", async () => {
		const fullPage = Array.from({ length: 100 }, (_, i) => ({
			id: i + 1,
			user: { login: "u" },
			body: `c${i}`,
		}));
		const listComments = mock.fn(async (params: Record<string, unknown>) =>
			(params as { page: number }).page === 1
				? { data: fullPage }
				: { data: [{ id: 101, user: null, body: "tail" }] },
		);

		const comments = await adapter({ listComments }).listComments(42, "owner/repo");

		assert.equal(comments.length, 101);
		assert.deepEqual(comments[0], { id: "1", author: { login: "u" }, body: "c0" });
		assert.deepEqual(comments[100], { id: "101", author: undefined, body: "tail" });
		assert.equal(listComments.mock.callCount(), 2);
		const first = listComments.mock.calls[0]!.arguments[0] as Record<string, unknown>;
		assert.equal(first.per_page, 100);
	});

	it("invalid repo format throws", async () => {
		await assert.rejects(() => adapter({}).listComments(1, "invalid"), /Invalid repo format/);
	});
});

describe("OctokitIssues.getAuthenticatedLogin (issue #2044)", () => {
	it("returns the authenticated user's login", async () => {
		const getAuthenticated = mock.fn(async () => ({ data: { login: "automation" } }));
		assert.equal(
			await rootAdapter({ users: { getAuthenticated } }).getAuthenticatedLogin(),
			"automation",
		);
		assert.equal(getAuthenticated.mock.callCount(), 1);
	});
});

// ═══════════════════════════════════════════════════════════════════
// No stale handles — the transport is read per call
// ═══════════════════════════════════════════════════════════════════

describe("OctokitIssues — no stale handle", () => {
	it("routes the second call to a swapped transport.octokit fake", async () => {
		const transport = fakeTransport({
			octokit: { issues: { get: mock.fn(async () => ({ data: { number: 1, title: "first" } })) } },
		});
		const client = new OctokitIssues(transport, createMockLogger());

		assert.equal((await client.getIssue(1, "owner/repo"))?.number, 1);

		transport.octokit = {
			issues: { get: mock.fn(async () => ({ data: { number: 2, title: "second" } })) },
		} as unknown as typeof transport.octokit;

		assert.equal((await client.getIssue(2, "owner/repo"))?.number, 2);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Structural pins — the base class sheds its abstract GraphQL dependency
// ═══════════════════════════════════════════════════════════════════

describe("octokit-issue-ops.ts — de-abstracted base", () => {
	it("no longer declares graphqlQuery", () => {
		const graph = readGraph(join(GITHUB_DIR, "octokit-issue-ops.ts"));
		assert.ok(
			!graph.declarations.includes("graphqlQuery"),
			"the abstract graphqlQuery hook must be gone; the base uses transport.query",
		);
	});

	it("no longer declares the octokit/graphql handles the subclass owned", () => {
		const graph = readGraph(join(GITHUB_DIR, "octokit-issue-ops.ts"));
		for (const name of ["octokit", "_graphql"]) {
			assert.ok(
				!graph.declarations.includes(name),
				`${name} must live on the transport, not the base class`,
			);
		}
	});
});

describe("OctokitIssues — own-method ceiling (CodeFlow ≤ 15)", () => {
	it("stays at or under 15 own prototype members and is non-vacuous", () => {
		const own = Object.getOwnPropertyNames(OctokitIssues.prototype).length - 1;
		assert.ok(own >= 1, "prototype must declare methods");
		assert.ok(own <= 15, `OctokitIssues has ${own} own methods (ceiling 15)`);
	});
});
