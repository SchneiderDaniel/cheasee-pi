// ─── Tests: github/octokit-projects.ts (issue #2098) ─────────────
// Phase 4 — the pagination loop now delegates response→domain mapping to the
// pure `mapProjectItemsPage`; cursor threading must be unchanged.
//
// Run with:
//   node --experimental-strip-types --test .pi/extensions/supervisor/test/github/octokit-projects.test.mts

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { OctokitProjects } from "../../github/octokit-projects.ts";
import { mapProjectItemsPage } from "../../github/parsers.ts";
import { fakeTransport, createMockLogger } from "./fake-transport.mts";

function adapter(query: (q: string) => Promise<unknown>): OctokitProjects {
	return new OctokitProjects(fakeTransport({ query }), createMockLogger());
}

// ═══════════════════════════════════════════════════════════════════
// mapProjectItemsPage — pure entity mapper
// ═══════════════════════════════════════════════════════════════════

describe("mapProjectItemsPage()", () => {
	it("maps one page to domain items plus cursor state", () => {
		const page = mapProjectItemsPage({
			pageInfo: { hasNextPage: true, endCursor: "CURSOR1" },
			nodes: [
				{
					id: "item1",
					content: { url: "https://github.com/o/r/issues/5", number: 5 },
					fieldValues: {
						nodes: [{ name: "In Progress", field: { id: "f1", name: "Status" } }],
					},
				},
			],
		});

		assert.deepEqual(page, {
			items: [
				{
					id: "item1",
					status: "In Progress",
					content: { url: "https://github.com/o/r/issues/5", number: 5 },
					fieldValues: [{ fieldId: "f1", value: "In Progress", optionId: undefined }],
				},
			],
			hasNextPage: true,
			endCursor: "CURSOR1",
		});
	});

	it("maps a node with null content to content: undefined", () => {
		const page = mapProjectItemsPage({ nodes: [{ id: "draft", content: null }] });
		assert.equal(page.items.length, 1);
		assert.equal(page.items[0]!.content, undefined);
	});

	it("maps empty nodes to an empty item list", () => {
		const page = mapProjectItemsPage({ pageInfo: { hasNextPage: false, endCursor: null } });
		assert.deepEqual(page.items, []);
	});

	it("treats a missing pageInfo as the last page", () => {
		const page = mapProjectItemsPage({ nodes: [{ id: "item1" }] });
		assert.equal(page.hasNextPage, false);
		assert.equal(page.endCursor, null);
		assert.equal(page.items.length, 1);
	});

	it("treats an undefined page as empty without throwing", () => {
		assert.deepEqual(mapProjectItemsPage(undefined), {
			items: [],
			hasNextPage: false,
			endCursor: null,
		});
	});
});

// ═══════════════════════════════════════════════════════════════════
// getProjectItems — pagination loop + cursor threading
// ═══════════════════════════════════════════════════════════════════

describe("OctokitProjects.getProjectItems", () => {
	it("threads the page-1 endCursor into the page-2 query and concatenates in order", async () => {
		const queries: string[] = [];
		const query = mock.fn(async (q: string) => {
			queries.push(q);
			if (queries.length === 1) {
				return {
					viewer: {
						projectV2: {
							items: {
								pageInfo: { hasNextPage: true, endCursor: "PAGE1" },
								nodes: [{ id: "a", content: { url: "u1", number: 1 } }],
							},
						},
					},
				};
			}
			return {
				viewer: {
					projectV2: {
						items: {
							pageInfo: { hasNextPage: false, endCursor: "PAGE2" },
							nodes: [{ id: "b", content: { url: "u2", number: 2 } }],
						},
					},
				},
			};
		});

		const items = await adapter(query).getProjectItems(7);

		assert.deepEqual(
			items.map((i) => i.id),
			["a", "b"],
		);
		assert.ok(!queries[0]!.includes("after:"), "first page must not send a cursor");
		assert.ok(queries[1]!.includes('after: "PAGE1"'), "second page must thread the cursor");
		assert.equal(query.mock.callCount(), 2);
	});

	it("stops after one query when hasNextPage is false", async () => {
		const query = mock.fn(async (_q: string) => ({
			viewer: {
				projectV2: {
					items: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [{ id: "only" }],
					},
				},
			},
		}));

		const items = await adapter(query).getProjectItems(7);

		assert.equal(query.mock.callCount(), 1);
		assert.equal(items.length, 1);
		assert.ok(!(query.mock.calls[0]!.arguments[0] as string).includes("after:"));
	});

	it("stops without throwing when a later page has no projectV2", async () => {
		const query = mock.fn(async (q: string) =>
			q.includes("after:")
				? {}
				: {
						viewer: {
							projectV2: {
								items: {
									pageInfo: { hasNextPage: true, endCursor: "NEXT" },
									nodes: [{ id: "a" }],
								},
							},
						},
					},
		);

		const items = await adapter(query).getProjectItems(7);

		assert.deepEqual(
			items.map((i) => i.id),
			["a"],
		);
		assert.equal(query.mock.callCount(), 2);
	});

	it("propagates a transport rejection as the GraphQL envelope", async () => {
		const client = adapter(async () => {
			throw new Error("GitHub GraphQL request failed: kaput");
		});
		await assert.rejects(
			() => client.getProjectItems(7),
			(err: Error) => err.message === "GitHub GraphQL request failed: kaput",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// getProjectFields / getProjectId / setItemStatusField
// ═══════════════════════════════════════════════════════════════════

describe("OctokitProjects.getProjectFields", () => {
	it("maps id/name/type/options and defaults a missing dataType to UNKNOWN", async () => {
		const client = adapter(async () => ({
			viewer: {
				projectV2: {
					fields: {
						nodes: [
							{
								id: "f1",
								name: "Status",
								dataType: "SINGLE_SELECT",
								options: [{ id: "o1", name: "Todo" }],
							},
							{ id: "f2", name: "Notes" },
						],
					},
				},
			},
		}));

		assert.deepEqual(await client.getProjectFields(3), [
			{
				id: "f1",
				name: "Status",
				type: "SINGLE_SELECT",
				options: [{ id: "o1", name: "Todo" }],
			},
			{ id: "f2", name: "Notes", type: "UNKNOWN", options: undefined },
		]);
	});

	it("returns [] for empty nodes", async () => {
		const client = adapter(async () => ({ viewer: { projectV2: { fields: { nodes: [] } } } }));
		assert.deepEqual(await client.getProjectFields(3), []);
	});
});

describe("OctokitProjects.getProjectId", () => {
	it("returns the project node id", async () => {
		const client = adapter(async () => ({ viewer: { projectV2: { id: "PVT_123" } } }));
		assert.equal(await client.getProjectId(3), "PVT_123");
	});

	it("returns an empty string when projectV2 is missing", async () => {
		const client = adapter(async () => ({}));
		assert.equal(await client.getProjectId(3), "");
	});
});

describe("OctokitProjects.setItemStatusField", () => {
	it("issues exactly one mutation query and resolves undefined", async () => {
		const query = mock.fn(async (_q: string) => ({}));
		const result = await adapter(query).setItemStatusField("ITEM", "PROJ", "FIELD", "OPT");

		assert.equal(result, undefined);
		assert.equal(query.mock.callCount(), 1);
		const mutation = query.mock.calls[0]!.arguments[0] as string;
		assert.ok(mutation.includes("updateProjectV2ItemFieldValue"));
		assert.ok(mutation.includes('"ITEM"'));
		assert.ok(mutation.includes('"OPT"'));
	});
});

// ═══════════════════════════════════════════════════════════════════
// Structural pins
// ═══════════════════════════════════════════════════════════════════

describe("OctokitProjects — own-method ceiling (CodeFlow ≤ 15)", () => {
	it("stays at or under 15 own prototype members and is non-vacuous", () => {
		const own = Object.getOwnPropertyNames(OctokitProjects.prototype).length - 1;
		assert.ok(own >= 1, "prototype must declare methods");
		assert.ok(own <= 15, `OctokitProjects has ${own} own methods (ceiling 15)`);
	});
});
