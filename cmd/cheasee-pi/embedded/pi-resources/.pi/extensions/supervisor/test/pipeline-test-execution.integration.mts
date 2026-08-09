/**
 * Integration tests for the full pipeline test execution gate.
 *
 * These tests verify end-to-end behavior across TestDesigner and Auditor agents.
 * They require a controlled environment — real GitHub project board or mock.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline-test-execution.integration.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import { extractTestCommand, parseFailedTests, truncateOutput } from "./helper/output-parser.mts";

import {
	buildPlanWithCommand,
	buildPlanWithoutCommand,
	buildPlanWithMultipleBlocks,
	buildPlanWithGlob,
} from "./helper/comment-builder.mts";

import {
	runCommand,
	mockRunCommand,
	mockRunCommandFactory,
	type ExecResult,
} from "./helper/mock-exec.mts";

// ---------------------------------------------------------------------------
// Full auditor decision simulation
// ---------------------------------------------------------------------------

/**
 * Simulates the Auditor's decision flow:
 * 1. Extract test command from test plan comment
 * 2. Execute it (mocked)
 * 3. If missing or fails → REJECT with appropriate format
 * 4. If passes → APPROVE
 */
function simulateAuditDecision(
	testPlanComment: string,
	mockExecResult: ExecResult | null, // null means the command itself is missing
): { decision: "APPROVE" | "REJECT"; comment: string } {
	const command = extractTestCommand(testPlanComment);

	// No command found
	if (!command) {
		return {
			decision: "REJECT",
			comment:
				"## Audit Rejected\n\nNo runnable test command found in test plan.\n\nPlease fix and resubmit.",
		};
	}

	// Execute (mocked)
	const exec = mockRunCommand(mockExecResult!);
	const result = exec(command);

	// Test failure
	if (!result.success) {
		const failures = parseFailedTests(result.stdout, result.stderr);
		const { text: stdoutText } = truncateOutput(result.stdout, 20);
		const { text: stderrText } = truncateOutput(result.stderr, 20);

		let comment = "## Audit Rejected\n\nTests failed. Fix before resubmitting.\n\n";

		if (failures.length > 0) {
			comment += "Failed tests:\n";
			for (const f of failures) {
				comment += `- ${f}\n`;
			}
			comment += "\n";
		}

		comment += `Stdout:\n${stdoutText || "(empty)"}\n\n`;
		comment += `Stderr:\n${stderrText || "(empty)"}\n`;

		return { decision: "REJECT", comment };
	}

	// Tests passed
	return {
		decision: "APPROVE",
		comment: `## Audit Approved\n\n- Architecture compliance: ✓\n- Tests passed: ✓ (ran: ${command})\n- Test coverage: ✓\n- Code quality: ✓\n- Completeness: ✓\n\nPR created. Ready for merge.`,
	};
}

// ---------------------------------------------------------------------------
// Integration scenario tests
// ---------------------------------------------------------------------------

describe("Integration — happy path (tests pass)", () => {
	it("3.1: plan with command + passing tests → APPROVE", () => {
		const comment = buildPlanWithCommand({
			command: "node --experimental-strip-types --test test/foo.test.mts",
		});
		const mockResult: ExecResult = {
			stdout: "ok 1 - passes\nok 2 - passes\n",
			stderr: "",
			success: true,
			exitCode: 0,
		};
		const result = simulateAuditDecision(comment, mockResult);
		assert.strictEqual(result.decision, "APPROVE");
		assert.ok(result.comment.includes("Tests passed: ✓"));
		assert.ok(result.comment.includes("node --experimental-strip-types --test test/foo.test.mts"));
	});

	it("3.2: APPROVE template keeps Test coverage line", () => {
		const comment = buildPlanWithCommand({ command: "node --test test/x.test.mts" });
		const mockResult: ExecResult = { stdout: "", stderr: "", success: true, exitCode: 0 };
		const result = simulateAuditDecision(comment, mockResult);
		assert.ok(result.comment.includes("Test coverage: ✓"));
	});

	it("3.3: stderr warnings with exit 0 still approve", () => {
		const comment = buildPlanWithCommand({ command: "node --test test/x.test.mts" });
		const mockResult: ExecResult = {
			stdout: "ok 1 - passes\n",
			stderr: "ExperimentalWarning: strip types is experimental\n",
			success: true,
			exitCode: 0,
		};
		const result = simulateAuditDecision(comment, mockResult);
		assert.strictEqual(result.decision, "APPROVE");
	});
});

describe("Integration — test failure path", () => {
	it("3.4: failing tests → REJECT with failed test names", () => {
		const comment = buildPlanWithCommand({ command: "node --test test/x.test.mts" });
		const mockResult: ExecResult = {
			stdout: "not ok 1 - broken feature\nnot ok 2 - edge case\n",
			stderr: "",
			success: false,
			exitCode: 1,
		};
		const result = simulateAuditDecision(comment, mockResult);
		assert.strictEqual(result.decision, "REJECT");
		assert.ok(result.comment.includes("Failed tests:"));
		assert.ok(result.comment.includes("broken feature"));
		assert.ok(result.comment.includes("edge case"));
	});

	it("3.5: rejection includes stdout and stderr sections", () => {
		const comment = buildPlanWithCommand({ command: "node --test test/x.test.mts" });
		const mockResult: ExecResult = {
			stdout: "line 1\nline 2\n",
			stderr: "error line 1\n",
			success: false,
			exitCode: 1,
		};
		const result = simulateAuditDecision(comment, mockResult);
		assert.ok(result.comment.includes("Stdout:"));
		assert.ok(result.comment.includes("Stderr:"));
	});

	it("3.6: no failures parsed → omits Failed tests section", () => {
		const comment = buildPlanWithCommand({ command: "node --test test/x.test.mts" });
		const mockResult: ExecResult = {
			stdout: "Some error output without TAP format\n",
			stderr: "",
			success: false,
			exitCode: 1,
		};
		const result = simulateAuditDecision(comment, mockResult);
		assert.strictEqual(result.decision, "REJECT");
		// Should NOT have "- [parsed test name]" bullet points
		assert.ok(!result.comment.includes("Failed tests:\n-"));
	});
});

describe("Integration — missing command path", () => {
	it("3.7: no test command in plan → REJECT", () => {
		const comment = buildPlanWithoutCommand();
		const result = simulateAuditDecision(comment, null);
		assert.strictEqual(result.decision, "REJECT");
		assert.ok(result.comment.includes("No runnable test command found in test plan"));
	});

	it("3.8: inline code only (not fenced) → REJECT", () => {
		const comment = "## Test Plan\nRun `node --test test/x.test.mts`";
		const result = simulateAuditDecision(comment, null);
		assert.strictEqual(result.decision, "REJECT");
	});
});

describe("Integration — broken command path", () => {
	it("3.9: file not found → REJECT with error output", () => {
		const comment = buildPlanWithCommand({ command: "node --test test/nonexistent.test.mts" });
		const mockResult: ExecResult = {
			stdout: "",
			stderr: "Error: Cannot find module './test/nonexistent.test.mts'\n",
			success: false,
			exitCode: 1,
		};
		const result = simulateAuditDecision(comment, mockResult);
		assert.strictEqual(result.decision, "REJECT");
		assert.ok(result.comment.includes("Cannot find module"));
	});

	it("3.10: syntax error in test → REJECT with error output", () => {
		const comment = buildPlanWithCommand({ command: "node --test test/syntax-error.test.mts" });
		const mockResult: ExecResult = {
			stdout: "",
			stderr: "SyntaxError: Unexpected token '}'\n",
			success: false,
			exitCode: 1,
		};
		const result = simulateAuditDecision(comment, mockResult);
		assert.strictEqual(result.decision, "REJECT");
		assert.ok(result.comment.includes("SyntaxError"));
	});
});

describe("Integration — multiple test files", () => {
	it("3.11: glob pattern command with passing tests → APPROVE", () => {
		const comment = buildPlanWithGlob();
		const mockResult: ExecResult = {
			stdout: "ok 1 - test 1\nok 2 - test 2\nok 3 - test 3\n",
			stderr: "",
			success: true,
			exitCode: 0,
		};
		const result = simulateAuditDecision(comment, mockResult);
		assert.strictEqual(result.decision, "APPROVE");
	});

	it("3.12: glob pattern with one failing file → REJECT with parsed failures", () => {
		const comment = buildPlanWithGlob();
		const mockResult: ExecResult = {
			stdout: "ok 1 - passes\nnot ok 2 - fails in second file\n",
			stderr: "",
			success: false,
			exitCode: 1,
		};
		const result = simulateAuditDecision(comment, mockResult);
		assert.strictEqual(result.decision, "REJECT");
		assert.ok(result.comment.includes("fails in second file"));
	});
});

describe("Integration — existing tests compatibility", () => {
	it("3.13: existing tests referenced in plan work with the flow", () => {
		const comment = buildPlanWithCommand({
			command: "node --experimental-strip-types --test test/supervisor-extensions.test.mts",
		});
		const mockResult: ExecResult = {
			stdout: "ok 1 - passes\n",
			stderr: "",
			success: true,
			exitCode: 0,
		};
		const result = simulateAuditDecision(comment, mockResult);
		assert.strictEqual(result.decision, "APPROVE");
	});

	it("3.14: empty stdout + empty stderr + exit 0 → APPROVE", () => {
		const comment = buildPlanWithCommand({ command: "node --test test/x.test.mts" });
		const mockResult: ExecResult = { stdout: "", stderr: "", success: true, exitCode: 0 };
		const result = simulateAuditDecision(comment, mockResult);
		assert.strictEqual(result.decision, "APPROVE");
	});
});
