import { describe, it } from "node:test";

import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { type PortCall } from "../helper/mock-github-port.ts";

import type {
	SupervisorConfig,
	ProjectField,
	AgentRunResult,
	FilteredIssueData,
} from "../../config/types.ts";

import {
	resolveAgentName,
	isDoneStatus,
	isRejectionLimitReached,
	type StageState,
	type AuditGateContext,
	type GateRejected,
} from "../../pipeline/stages/index.ts";

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve(results[idx++] || { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: {
				fg: (_style: string, text: string) => text,
			},
		},
	} as unknown as ExtensionCommandContext;
}

const mockConfig: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {
		Backlog: "",
		Architecture: "architect",
		Research: "researcher",
		TestDesign: "test-designer",
		Implementation: "developer",
		Audit: "auditor",
		Done: "",
	},
	maxRejections: 3,
	codeowners: ["user1"],
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../worktrees",
	branchPrefix: "worktree-git-issue-",
	ciGatingTimeoutSec: 300,
	bellOnComplete: false,
	enableExperimentalFeatures: false,
	auditScoreThreshold: 0.75,
	vulnGateBlocking: false,
	vulnGateTimeoutSec: 60,
};

function makeProjectFields(statusFieldId: string): ProjectField[] {
	return [
		{
			id: statusFieldId,
			name: "Status",
			type: "single_select",
			options: [
				{ id: "opt_bk", name: "Backlog" },
				{ id: "opt_re", name: "Research" },
				{ id: "opt_ar", name: "Architecture" },
				{ id: "opt_td", name: "TestDesign" },
				{ id: "opt_im", name: "Implementation" },
				{ id: "opt_au", name: "Audit" },
				{ id: "opt_dn", name: "Done" },
			],
		},
	];
}

function wrapJsonOutput(obj: Record<string, unknown>): string {
	return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

describe("resolveAgentName()", () => {
	it("returns mapped agent name for known status via workflow agentName", () => {
		// "Architecture" maps to "architect" in WORKFLOW's agentName
		const result = resolveAgentName("Architecture", mockConfig);
		assert.equal(result, "architect");
	});

	it("returns null for unknown status", () => {
		const result = resolveAgentName("NonExistentStatus", mockConfig);
		assert.equal(result, null);
	});

	it("returns null when status has no agent mapping and no statusMapping entry", () => {
		// "Done" is in WORKFLOW, has no agentName property, and not in statusMapping
		const result = resolveAgentName("Done", { ...mockConfig, statusMapping: {} });
		assert.equal(result, null);
	});
});
describe("isDoneStatus()", () => {
	it("returns true for 'Done'", () => {
		assert.equal(isDoneStatus("Done"), true);
	});

	it("returns true for 'done' (lowercase)", () => {
		assert.equal(isDoneStatus("done"), true);
	});

	it("returns true for 'DONE' (uppercase)", () => {
		assert.equal(isDoneStatus("DONE"), true);
	});

	it("returns false for any other string", () => {
		assert.equal(isDoneStatus("Architecture"), false);
		assert.equal(isDoneStatus("In Progress"), false);
		assert.equal(isDoneStatus(""), false);
		assert.equal(isDoneStatus("don"), false);
	});
});
describe("isRejectionLimitReached()", () => {
	it("returns { reached: true, count } when count >= maxRejections", () => {
		assert.deepEqual(isRejectionLimitReached(3, 3), { reached: true, count: 3 });
	});

	it("returns { reached: false, count } when below maxRejections", () => {
		assert.deepEqual(isRejectionLimitReached(1, 3), { reached: false, count: 1 });
	});

	it("count == max is the boundary → reached", () => {
		assert.deepEqual(isRejectionLimitReached(5, 5), { reached: true, count: 5 });
	});

	it("returns { reached: false, count: 0 } when maxRejections is 0", () => {
		assert.deepEqual(isRejectionLimitReached(2, 0), { reached: false, count: 0 });
	});

	it("returns { reached: false, count: 0 } when maxRejections is undefined", () => {
		assert.deepEqual(isRejectionLimitReached(2, undefined), { reached: false, count: 0 });
	});

	it("maxRejections negative → { reached: false, count: 0 } (falsy guard preserved)", () => {
		assert.deepEqual(isRejectionLimitReached(2, -1), { reached: false, count: 0 });
	});

	it("count 0 → not reached even with a limit configured", () => {
		assert.deepEqual(isRejectionLimitReached(0, 3), { reached: false, count: 0 });
	});
});
