// ─── Tests: github/project.ts — project board operations ─────────
// Integration tests with mock ghGraphQL. No network calls.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecFn } from "../../pipeline/helpers.ts";
import {
	getProjectFields,
	getProjectItems,
	getProjectId,
	setItemStatus,
} from "../../github/project.ts";
import { findIssueItem } from "../../lib/issue-filter.ts";
import type { ProjectItem, ProjectField } from "../../config/types";

// ─── Helpers ──────────────────────────────────────────────────────

function createMockExec(ghResult: { code: number; stdout: string; stderr: string }): ExecFn {
	return async () => ({ ...ghResult, killed: false });
}

// ─── Tests: getProjectFields() ────────────────────────────────────

describe("getProjectFields()", () => {
	it("calls ghGraphQL with project field list query and parses response", async () => {
		const ghResponse = {
			data: {
				viewer: {
					projectV2: {
						fields: {
							nodes: [
								{
									id: "f1",
									name: "Status",
									dataType: "SINGLE_SELECT",
									options: [{ id: "o1", name: "Done" }],
								},
								{ id: "f2", name: "Priority", dataType: "TEXT" },
							],
						},
					},
				},
			},
		};
		const exec = createMockExec({ code: 0, stdout: JSON.stringify(ghResponse), stderr: "" });
		const fields = await getProjectFields(exec, 1);
		assert.equal(fields.length, 2);
		assert.equal(fields[0].name, "Status");
		assert.equal(fields[0].type, "SINGLE_SELECT");
		assert.deepEqual(fields[0].options, [{ id: "o1", name: "Done" }]);
		assert.equal(fields[1].name, "Priority");
		assert.equal(fields[1].type, "TEXT");
	});

	it("returns empty array when no fields found", async () => {
		const ghResponse = { data: { viewer: { projectV2: { fields: { nodes: [] } } } } };
		const exec = createMockExec({ code: 0, stdout: JSON.stringify(ghResponse), stderr: "" });
		const fields = await getProjectFields(exec, 999);
		assert.deepEqual(fields, []);
	});
});

// ─── Tests: getProjectItems() ─────────────────────────────────────

describe("getProjectItems()", () => {
	it("returns typed ProjectItem[] from GraphQL response", async () => {
		const ghResponse = {
			data: {
				viewer: {
					projectV2: {
						items: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [
								{
									id: "item1",
									content: { number: 123, url: "https://github.com/owner/repo/issues/123" },
									fieldValues: {
										nodes: [{ name: "In Progress", field: { id: "f1", name: "Status" } }],
									},
								},
							],
						},
					},
				},
			},
		};
		const exec = createMockExec({ code: 0, stdout: JSON.stringify(ghResponse), stderr: "" });
		const items = await getProjectItems(exec, 1);
		assert.equal(items.length, 1);
		assert.equal(items[0].id, "item1");
		assert.equal(items[0].status, "In Progress");
		assert.equal(items[0].content?.number, 123);
	});

	it("returns empty array when no items exist", async () => {
		const ghResponse = {
			data: {
				viewer: {
					projectV2: {
						items: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [],
						},
					},
				},
			},
		};
		const exec = createMockExec({ code: 0, stdout: JSON.stringify(ghResponse), stderr: "" });
		const items = await getProjectItems(exec, 999);
		assert.deepEqual(items, []);
	});
});

// ─── Tests: getProjectId() ────────────────────────────────────────

describe("getProjectId()", () => {
	it("extracts project ID from ghGraphQL response", async () => {
		const ghResponse = { data: { viewer: { projectV2: { id: "PVT_123" } } } };
		const exec = createMockExec({ code: 0, stdout: JSON.stringify(ghResponse), stderr: "" });
		const id = await getProjectId(exec, 1);
		assert.equal(id, "PVT_123");
	});

	it("returns empty string when project not found", async () => {
		const ghResponse = { data: { viewer: { projectV2: null } } };
		const exec = createMockExec({ code: 0, stdout: JSON.stringify(ghResponse), stderr: "" });
		const id = await getProjectId(exec, 999);
		assert.equal(id, "");
	});
});

// ─── Tests: findIssueItem() ───────────────────────────────────────

describe("findIssueItem()", () => {
	it("returns matching item by number", () => {
		const items: ProjectItem[] = [
			{ id: "i1", content: { number: 100, url: "https://github.com/o/r/issues/100" } },
			{ id: "i2", content: { number: 200, url: "https://github.com/o/r/issues/200" } },
		];
		const result = findIssueItem(items, 100);
		assert.ok(result !== null);
		assert.equal(result!.id, "i1");
	});

	it("returns null when no match found", () => {
		const items: ProjectItem[] = [{ id: "i1", content: { number: 100, url: "" } }];
		const result = findIssueItem(items, 999);
		assert.equal(result, null);
	});

	it("returns null for empty items array", () => {
		const result = findIssueItem([], 100);
		assert.equal(result, null);
	});

	it("matches by URL pattern when number is undefined", () => {
		const items: ProjectItem[] = [
			{ id: "i1", content: { url: "https://github.com/o/r/issues/300" } },
		];
		const result = findIssueItem(items, 300);
		assert.equal(result?.id, "i1");
	});
});

// ─── Tests: setItemStatus() ───────────────────────────────────────

describe("setItemStatus()", () => {
	it("calls gh() with project item-edit command and correct args", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const exec: ExecFn = async (cmd: string, args: string[]) => {
			calls.push({ cmd, args: args || [] });
			return { code: 0, stdout: "", stderr: "", killed: false };
		};
		await setItemStatus(exec, "item1", "proj1", "f_status", "opt_done");
		assert.equal(calls.length, 1);
		const callArgs = calls[0].args;
		assert.ok(callArgs.includes("item-edit"));
		assert.ok(callArgs.includes("--id"));
		assert.ok(callArgs.includes("item1"));
		assert.ok(callArgs.includes("--project-id"));
		assert.ok(callArgs.includes("proj1"));
		assert.ok(callArgs.includes("--field-id"));
		assert.ok(callArgs.includes("f_status"));
		assert.ok(callArgs.includes("--single-select-option-id"));
		assert.ok(callArgs.includes("opt_done"));
	});
});
