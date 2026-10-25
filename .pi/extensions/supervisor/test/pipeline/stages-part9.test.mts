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
	createStageState,
	type StageState,
	type AuditGateContext,
	type GateRejected,
	validateResearcherFindings,
	hasBranchCommits,
	applyGateFailureContext,
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

describe("validateResearcherFindings()", () => {
	it("skip message with 'Research skipped:' → returns original string unchanged", () => {
		const msg =
			"## Research Findings — Research skipped: issue touches only internal code with no external dependency, library, or version question. No public web data needed.";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("graceful degradation message → returns original string unchanged", () => {
		const msg = "## Research Findings — No relevant results found for this topic.";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("substantive findings with bullets → returns original string unchanged", () => {
		const msg =
			"## Research Findings\n\n### Best Practices\n- Use version 5.0 — https://example.com\n- Enable strict mode — https://example.com\n\n### Common Pitfalls\n- Avoid global state — https://example.com";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("empty headers only (no bullet content) → returns graceful degradation message", () => {
		const msg = "## Research Findings\n\n### Best Practices\n- —\n\n### Common Pitfalls\n- —";
		const result = validateResearcherFindings(msg);
		assert.ok(
			result.includes("No relevant results found"),
			"Should fall back to graceful degradation",
		);
		assert.notEqual(result, msg);
	});

	it("empty string → returns graceful degradation message", () => {
		const result = validateResearcherFindings("");
		assert.ok(result.includes("No relevant results found"));
	});

	it("skip message with different reason → returns original unchanged", () => {
		const msg = "## Research Findings — Research skipped: Bug fix — config change only";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("substantive bullet content alongside skip prefix → returns original unchanged (skip detection doesn't override real findings)", () => {
		const msg =
			"## Research Findings — Research skipped: minor\n\n### Best Practices\n- Use version 5.0 — https://example.com";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("content with 'Research skipped:' in middle of text → returns original unchanged", () => {
		const msg =
			"## Research Findings\n\nSome content here. Research skipped: this shouldn't match mid-line.\n- Real finding — https://example.com";
		const result = validateResearcherFindings(msg);
		assert.equal(result, msg);
	});

	it("skip message at different position (start, middle, end) → all return original", () => {
		const msgs = [
			"## Research Findings — Research skipped: internal change. No web research needed.",
			"## Research Findings — Research skipped: refactor only. No external dependencies.",
			"## Research Findings — Research skipped: documentation update. No code changes.",
		];
		for (const msg of msgs) {
			const result = validateResearcherFindings(msg);
			assert.equal(result, msg, `Failed for: ${msg}`);
		}
	});
});
describe("hasBranchCommits()", () => {
	it("returns true when rev-list shows commits ahead of base", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const mockExec = async (
			cmd: string,
			args: string[],
			_opts?: Record<string, unknown>,
		): Promise<{ code: number; stdout: string; stderr: string }> => {
			calls.push({ cmd, args });
			return { code: 0, stdout: "3", stderr: "" };
		};

		const result = await hasBranchCommits(mockExec, "/repo", "feature", "main");
		assert.equal(result, true);

		// Verify git rev-list was called correctly
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "git");
		assert.ok(calls[0].args.includes("rev-list"));
		assert.ok(calls[0].args.includes("--count"));
	});

	it("returns false when rev-list shows 0 commits ahead", async () => {
		const mockExec = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
			return { code: 0, stdout: "0", stderr: "" };
		};

		const result = await hasBranchCommits(mockExec, "/repo", "feature", "main");
		assert.equal(result, false);
	});

	it("returns true when rev-list command fails (fail-safe)", async () => {
		const mockExec = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
			return { code: 1, stdout: "", stderr: "fatal: ambiguous argument" };
		};

		const result = await hasBranchCommits(mockExec, "/repo", "feature", "main");
		assert.equal(result, true, "should return true on failure (fail-safe)");
	});

	it("returns true when rev-list throws (fail-safe)", async () => {
		const mockExec = async (): Promise<never> => {
			throw new Error("network error");
		};

		const result = await hasBranchCommits(mockExec, "/repo", "feature", "main");
		assert.equal(result, true, "should return true on exception (fail-safe)");
	});

	it("uses correct range syntax: main..feature", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const mockExec = async (
			cmd: string,
			args: string[],
			_opts?: Record<string, unknown>,
		): Promise<{ code: number; stdout: string; stderr: string }> => {
			calls.push({ cmd, args });
			return { code: 0, stdout: "1", stderr: "" };
		};

		await hasBranchCommits(mockExec, "/repo", "my-feature", "main");
		// The range should be "main..my-feature"
		const revListArgs = calls[0].args;
		const rangeArg = revListArgs.find((a: string) => a.includes(".."));
		assert.ok(rangeArg, "should contain a range with ..");
		assert.equal(rangeArg, "main..my-feature", "range should be baseBranch..headBranch");
	});
});
describe("applyGateFailureContext() — gateFailureHistory", () => {
	it("initial state has empty gateFailureHistory", () => {
		const state = createStageState("Implementation");
		assert.ok(Array.isArray(state.gateFailureHistory), "gateFailureHistory should be an array");
		assert.equal(state.gateFailureHistory.length, 0, "should start empty");
	});

	it("pushes note to gateFailureHistory on Implementation with non-empty note", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "Some gate failure", 1);
		assert.equal(state.gateFailureHistory.length, 1, "should have 1 entry");
		assert.ok(state.gateFailureHistory[0]!.includes("run 1"), "entry should include run number");
	});

	it("pushes note to gateFailureHistory that includes run number", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- CI Gate ---\nSomething failed", 1);
		assert.equal(state.gateFailureHistory.length, 1);
		const entry = state.gateFailureHistory[0]!;
		assert.ok(entry.includes("CI Gate"), "entry should include gate name");
		assert.ok(entry.includes("run 1"), "entry should include run number");
		assert.ok(entry.includes("developer restarted"), "entry should mention developer restarted");
	});

	it("calling twice appends 2 entries", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- CI Gate ---\nFail 1", 1);
		applyGateFailureContext(state, "Implementation", "--- TSC Gate ---\nFail 2", 2);
		assert.equal(state.gateFailureHistory.length, 2, "should have 2 entries");
		assert.ok(state.gateFailureHistory[0]!.includes("CI Gate"), "first entry is CI Gate");
		assert.ok(state.gateFailureHistory[0]!.includes("run 1"), "first entry has run 1");
		assert.ok(state.gateFailureHistory[1]!.includes("TSC Gate"), "second entry is TSC Gate");
		assert.ok(state.gateFailureHistory[1]!.includes("run 2"), "second entry has run 2");
	});

	it("does NOT push when effectiveNextStatus is Audit", () => {
		const state = createStageState("Implementation");
		state.gateFailureContext = "previous failure";
		applyGateFailureContext(state, "Audit", "some note", 1);
		// Should clear gateFailureContext but NOT add to gateFailureHistory
		assert.equal(state.gateFailureContext, undefined, "gateFailureContext should be cleared");
		assert.equal(state.gateFailureHistory.length, 0, "gateFailureHistory should still be empty");
	});

	it("does NOT push when note is empty", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "", 1);
		assert.equal(state.gateFailureHistory.length, 0, "should not push empty note");
	});

	it("does NOT push when note is whitespace only", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "   ", 1);
		assert.equal(state.gateFailureHistory.length, 0, "should not push whitespace note");
	});

	it("does NOT push when effectiveNextStatus is neither Implementation nor Audit", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Done", "some note", 1);
		assert.equal(state.gateFailureHistory.length, 0, "should not push on other statuses");
		assert.equal(
			state.gateFailureContext,
			undefined,
			"gateFailureContext unchanged for non-Implementation/Audit",
		);
	});

	it("still sets gateFailureContext (iteration-local context) even on push", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- Dead Code Gate ---\nFound dead code", 3);
		assert.equal(state.gateFailureContext, "--- Dead Code Gate ---\nFound dead code");
		assert.equal(state.gateFailureHistory.length, 1);
	});

	it("extracts gate name from note with --- markers", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- CI Gate ---\nCI check failed", 2);
		const entry = state.gateFailureHistory[0]!;
		assert.ok(entry.includes("CI Gate"), "should extract 'CI Gate' from note");
		assert.ok(entry.includes("run 2"), "entry should include run number");
	});

	it("falls back to 'Pre-transition' when no --- markers in note", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "Some generic failure without markers", 1);
		const entry = state.gateFailureHistory[0]!;
		assert.ok(entry.startsWith("Pre-transition"), "should use fallback gate name when no markers");
	});

	it("accumulates 3+ entries (no capping)", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- CI Gate ---\nFail 1", 1);
		applyGateFailureContext(state, "Implementation", "--- TSC Gate ---\nFail 2", 2);
		applyGateFailureContext(state, "Implementation", "--- LSP Gate ---\nFail 3", 3);
		applyGateFailureContext(state, "Implementation", "--- Dead Code Gate ---\nFail 4", 4);
		assert.equal(state.gateFailureHistory.length, 4, "all 4 entries should be present");
	});

	it("gateFailureContext cleared on Audit, gateFailureHistory preserved", () => {
		const state = createStageState("Implementation");
		applyGateFailureContext(state, "Implementation", "--- CI Gate ---\nFail", 1);
		assert.equal(state.gateFailureHistory.length, 1, "history has 1 entry after push");
		applyGateFailureContext(state, "Audit", "", 2);
		assert.equal(state.gateFailureContext, undefined, "context cleared on Audit");
		assert.equal(state.gateFailureHistory.length, 1, "history preserved on Audit");
	});
});
