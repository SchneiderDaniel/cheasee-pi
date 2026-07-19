// ─── Tests: github/parsers.ts — pure domain parsers ──────────────
// Table-driven tests for parseDepsTimeline and extractProjectItemFields.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDepsTimeline, extractProjectItemFields } from "../../github/parsers.ts";
import type { GhTimelineNode, ProjectFieldValueNode } from "../../config/types";

// ─── parseDepsTimeline ───────────────────────────────────────────

describe("parseDepsTimeline()", () => {
	it("returns blocked=false when nodes is null", () => {
		const result = parseDepsTimeline(null);
		assert.equal(result.blocked, false);
		assert.deepEqual(result.blockers, []);
	});

	it("returns blocked=false when nodes is undefined", () => {
		const result = parseDepsTimeline(undefined);
		assert.equal(result.blocked, false);
		assert.deepEqual(result.blockers, []);
	});

	it("returns blocked=false when nodes is empty", () => {
		const result = parseDepsTimeline([]);
		assert.equal(result.blocked, false);
		assert.deepEqual(result.blockers, []);
	});

	it("returns blocking issue when single open blocker exists", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Open blocker", state: "OPEN" },
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blocked, true);
		assert.equal(result.blockers.length, 1);
		assert.equal(result.blockers[0].number, 456);
		assert.equal(result.blockers[0].title, "Open blocker");
		assert.equal(result.blockers[0].state, "OPEN");
		assert.equal(result.blockers[0].type, "issue");
	});

	it("filters out closed blocking issues", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Closed blocker", state: "CLOSED" },
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blocked, false);
		assert.equal(result.blockers.length, 0);
	});

	it("defaults null/undefined state to UNKNOWN and includes it", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "No state", state: null as unknown as string },
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blocked, true);
		assert.equal(result.blockers.length, 1);
		assert.equal(result.blockers[0].state, "UNKNOWN");
	});

	it("defaults empty title to empty string", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "", state: "OPEN" },
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blocked, true);
		assert.equal(result.blockers[0].title, "");
	});

	it("BlockedByRemovedEvent after BlockedByAddedEvent excludes the issue", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Blocker", state: "OPEN" },
			},
			{
				__typename: "BlockedByRemovedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Blocker", state: "OPEN" },
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blocked, false);
		assert.equal(result.blockers.length, 0);
	});

	it("BlockedByAddedEvent after BlockedByRemovedEvent includes the issue (last wins)", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByRemovedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Blocker", state: "OPEN" },
			},
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Blocker", state: "OPEN" },
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blocked, true);
		assert.equal(result.blockers.length, 1);
	});

	it("includes multiple distinct blocking issues", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Blocker A", state: "OPEN" },
			},
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i2", number: 789, title: "Blocker B", state: "OPEN" },
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blocked, true);
		assert.equal(result.blockers.length, 2);
	});

	it("deduplicates duplicate events for same issue number", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Blocker", state: "OPEN" },
			},
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Blocker", state: "OPEN" },
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blockers.length, 1);
	});

	it("skips nodes with null blockingIssue gracefully", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Blocker", state: "OPEN" },
			},
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: null,
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blockers.length, 1);
		assert.equal(result.blockers[0].number, 456);
	});

	it("skips nodes with missing __typename", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Blocker", state: "OPEN" },
			},
			{
				__typename: "" as string,
				blockingIssue: { id: "i2", number: 789, title: "Ghost", state: "OPEN" },
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blockers.length, 1);
		assert.equal(result.blockers[0].number, 456);
	});

	it("includes OPEN state blocking issues", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Open blocker", state: "OPEN" },
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blocked, true);
		assert.equal(result.blockers[0].state, "OPEN");
	});

	it("includes non-CLOSED states like MERGED", () => {
		const nodes: GhTimelineNode[] = [
			{
				__typename: "BlockedByAddedEvent",
				blockingIssue: { id: "i1", number: 456, title: "Merged PR", state: "MERGED" },
			},
		];
		const result = parseDepsTimeline(nodes);
		assert.equal(result.blocked, true);
		assert.equal(result.blockers[0].state, "MERGED");
	});
});

// ─── extractProjectItemFields ─────────────────────────────────────

describe("extractProjectItemFields()", () => {
	it("returns empty result when fieldValueNodes is null", () => {
		const result = extractProjectItemFields(null);
		assert.equal(result.status, undefined);
		assert.equal(result.fieldValues, undefined);
	});

	it("returns empty result when fieldValueNodes is undefined", () => {
		const result = extractProjectItemFields(undefined);
		assert.equal(result.status, undefined);
		assert.equal(result.fieldValues, undefined);
	});

	it("returns empty result when fieldValueNodes is empty", () => {
		const result = extractProjectItemFields([]);
		assert.equal(result.status, undefined);
		assert.equal(result.fieldValues, undefined);
	});

	it("extracts status from field named 'Status' (exact case)", () => {
		const nodes: ProjectFieldValueNode[] = [
			{ name: "In Progress", field: { id: "f1", name: "Status" } },
		];
		const result = extractProjectItemFields(nodes);
		assert.equal(result.status, "In Progress");
		assert.equal(result.fieldValues?.length, 1);
		assert.equal(result.fieldValues![0].fieldId, "f1");
		assert.equal(result.fieldValues![0].value, "In Progress");
	});

	it("extracts status from field named 'status' (lowercase)", () => {
		const nodes: ProjectFieldValueNode[] = [
			{ name: "Done", field: { id: "f1", name: "status" } },
		];
		const result = extractProjectItemFields(nodes);
		assert.equal(result.status, "Done");
	});

	it("extracts status from field named 'STATUS' (uppercase)", () => {
		const nodes: ProjectFieldValueNode[] = [
			{ name: "Todo", field: { id: "f1", name: "STATUS" } },
		];
		const result = extractProjectItemFields(nodes);
		assert.equal(result.status, "Todo");
	});

	it("uses text value when name is absent", () => {
		const nodes: ProjectFieldValueNode[] = [
			{ text: "Some text value", field: { id: "f1", name: "Description" } },
		];
		const result = extractProjectItemFields(nodes);
		assert.equal(result.status, undefined);
		assert.equal(result.fieldValues![0].value, "Some text value");
	});

	it("skips fields with null/undefined field.id", () => {
		const nodes: ProjectFieldValueNode[] = [
			{ name: "Value", field: { id: "", name: "Broken" } },
		];
		const result = extractProjectItemFields(nodes);
		assert.equal(result.fieldValues, undefined);
	});

	it("captures multiple fields, only Status sets status", () => {
		const nodes: ProjectFieldValueNode[] = [
			{ name: "High", field: { id: "f1", name: "Priority" } },
			{ name: "In Progress", field: { id: "f2", name: "Status" } },
			{ name: "Frontend", field: { id: "f3", name: "Team" } },
		];
		const result = extractProjectItemFields(nodes);
		assert.equal(result.status, "In Progress");
		assert.equal(result.fieldValues?.length, 3);
	});

	it("handles mixed SingleSelectValue (name) and TextValue (text)", () => {
		const nodes: ProjectFieldValueNode[] = [
			{ name: "In Progress", field: { id: "f1", name: "Status" } },
			{ text: "Some notes", field: { id: "f2", name: "Notes" } },
		];
		const result = extractProjectItemFields(nodes);
		assert.equal(result.status, "In Progress");
		assert.equal(result.fieldValues?.length, 2);
		assert.equal(result.fieldValues![0].value, "In Progress");
		assert.equal(result.fieldValues![1].value, "Some notes");
	});

	it("returns undefined fieldValues when no fields have id", () => {
		const nodes: ProjectFieldValueNode[] = [
			{ name: "In Progress" },
		];
		const result = extractProjectItemFields(nodes);
		assert.equal(result.status, undefined);
		assert.equal(result.fieldValues, undefined);
	});

	it("returns undefined status when no field named Status", () => {
		const nodes: ProjectFieldValueNode[] = [
			{ name: "High", field: { id: "f1", name: "Priority" } },
		];
		const result = extractProjectItemFields(nodes);
		assert.equal(result.status, undefined);
		assert.equal(result.fieldValues?.length, 1);
	});
});
