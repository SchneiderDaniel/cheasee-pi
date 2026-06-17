/**
 * Tests for Issue #525 — In-process agent runner leaks subagent context.
 *
 * Bug 1: Notification payload trimming — stop subagent output leak into supervisor session
 * Bug 2: Model resolution guard — throw on failure instead of silent fallback
 *
 * Phase 1: Source-structure tests for agent-session-runner.ts (Bug 2 fix)
 * Phase 2: Source-structure tests for notifications.ts (Bug 1 fix)
 * Phase 3: Source-structure tests for types.ts (Bug 1 — SupervisorMessageDetails update)
 * Phase 4: Unit mock tests for sendAgentResultMessage (Bug 1)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-issue-525.test.mts
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { readFileSync } from "node:fs";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Source-structure — agent-session-runner.ts model guard (Bug 2)
// ═══════════════════════════════════════════════════════════════════════

describe("Bug 2 — Model resolution guard in session-runner.ts", () => {
	const source = readFileSync(".pi/extensions/supervisor/agent/session-runner.ts", "utf-8");
	const lines = source.split("\n");

	// ── 1.1: Catch block is non-empty (no silent empty catch) ──

	it("1.1: catch block around getModel() contains throw or error log + throw", () => {
		// Find the try block with getModel
		const tryIdx = lines.findIndex(
			(l) => l.includes("try {") && source.indexOf("getModel(", source.indexOf(l)) > 0,
		);
		// Search more broadly: find lines with "} catch {" near getModel
		const catchLine = lines.findIndex(
			(l, i) =>
				l.includes("} catch") &&
				i > 0 &&
				lines.slice(Math.max(0, i - 5), i).some((pl) => pl.includes("getModel(")),
		);
		// If exact match fails, find any } catch { in getModel context
		const catchIdx =
			catchLine >= 0
				? catchLine
				: lines.findIndex(
						(l, i) =>
							l.trim().startsWith("}") &&
							l.includes("catch") &&
							!l.includes("//") &&
							i > 0 &&
							lines[i - 1]?.includes("getModel("),
					);

		assert.ok(catchIdx >= 0, "Must have a catch block after getModel() try");

		// Look at the next line(s) after the catch to check it's non-empty
		const afterCatchLines: string[] = [];
		for (let i = catchIdx + 1; i < Math.min(catchIdx + 10, lines.length); i++) {
			const trimmed = lines[i].trim();
			if (trimmed.startsWith("}")) break;
			if (trimmed && !trimmed.startsWith("//")) {
				afterCatchLines.push(trimmed);
			}
		}

		// Must have at least one non-comment statement
		assert.ok(
			afterCatchLines.length > 0,
			"Catch block must not be empty. Found lines after catch: " + JSON.stringify(afterCatchLines),
		);

		// Must contain a throw or log.error + throw
		const hasThrow = afterCatchLines.some(
			(l) => l.includes("throw") || l.includes("throw new Error") || l.includes("Error("),
		);
		assert.ok(hasThrow, "Catch block must throw an error (not just log.warn)");
	});

	// ── 1.2: Explicit guard before createAgentSession ──

	it("1.2: has guard before createAgentSession: if (!resolvedModel) throw", () => {
		// Find createAgentSession call
		const createSessionIdx = lines.findIndex((l) => l.includes("createAgentSession({"));
		assert.ok(createSessionIdx >= 0, "createAgentSession call must exist");

		// Look backward from createAgentSession for the guard (use wide window
		// since tool list building and extension resolution sit between guard and call)
		const beforeBlock = lines.slice(Math.max(0, createSessionIdx - 60), createSessionIdx);

		// Check if block contains both a resolvedModel guard AND a throw statement.
		// The guard spans multiple lines: `if (!resolvedModel) {` / `throw new Error(...)`
		const hasResolvedModelGuard = beforeBlock.some(
			(l) => l.includes("!resolvedModel") || (l.includes("resolvedModel") && l.includes("!")),
		);
		const hasThrow = beforeBlock.some((l) => l.includes("throw new Error"));
		assert.ok(
			hasResolvedModelGuard && hasThrow,
			"Must have guard like 'if (!resolvedModel) throw new Error(...)' before createAgentSession. " +
				"Found resolvedModel guard: " +
				hasResolvedModelGuard +
				", found throw: " +
				hasThrow +
				". Lines before createAgentSession: [" +
				beforeBlock.join(" | ") +
				"]",
		);
	});

	// ── 1.3: Error message includes agent.config.model ──

	it("1.3: error message when model unresolvable includes agent.config.model", () => {
		// Find the guard lines — look back 60 lines from createAgentSession
		const createSessionIdx = lines.findIndex((l) => l.includes("createAgentSession({"));
		const beforeBlock = lines.slice(Math.max(0, createSessionIdx - 60), createSessionIdx);

		// Check for !resolvedModel guard pattern
		const hasGuard = beforeBlock.some(
			(l) => l.includes("!resolvedModel") || (l.includes("resolvedModel") && l.includes("!")),
		);
		assert.ok(hasGuard, "Guard with !resolvedModel check must exist");

		// Check the block contains a throw and a model reference (may be on adjacent lines)
		const hasThrow = beforeBlock.some((l) => l.includes("throw new Error"));
		const hasModelName = beforeBlock.some(
			(l) => l.includes("agent.config.model") || l.includes("modelStr") || l.includes("modelInfo"),
		);

		assert.ok(hasThrow, "Guard must throw an Error");
		assert.ok(
			hasModelName,
			"Error message must reference agent.config.model or modelStr in throw context",
		);
	});

	// ── 1.4: Guard prevents createAgentSession call when model undefined ──

	it("1.4: error path does NOT call createAgentSession when model is undefined", () => {
		const createSessionIdx = lines.findIndex((l) => l.includes("createAgentSession({"));
		const beforeBlock = lines.slice(Math.max(0, createSessionIdx - 60), createSessionIdx);

		// Find the guard that checks resolvedModel
		const hasGuard = beforeBlock.some(
			(l) => l.includes("!resolvedModel") || (l.includes("resolvedModel") && l.includes("!")),
		);
		const hasThrow = beforeBlock.some((l) => l.includes("throw new Error"));

		assert.ok(
			hasGuard && hasThrow,
			"Must throw before createAgentSession when resolvedModel is undefined. " +
				"hasGuard=" +
				hasGuard +
				" hasThrow=" +
				hasThrow,
		);

		// Verify the block references the agent config model name
		// (the model name may be on a different line than throw keyword)
		const hasModelNameInBlock = beforeBlock.some(
			(l) => l.includes("agent.config.model") || l.includes("modelStr"),
		);
		assert.ok(
			hasModelNameInBlock,
			"Error message must reference agent.config.model for clear error message",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Source-structure — notifications.ts payload trimming (Bug 1)
// ═══════════════════════════════════════════════════════════════════════

describe("Bug 1 — Notifications payload trimming in notifications.ts", () => {
	const source = readFileSync(".pi/extensions/supervisor/pipeline/notifications.ts", "utf-8");
	const lines = source.split("\n");

	// ── 2.1: output/textOutput/textOnly removed from pi.sendMessage details ──

	it("2.1: sendAgentResultMessage details no longer passes 'output' field", () => {
		// Find details object in sendAgentResultMessage
		const detailsStart = lines.findIndex(
			(l) =>
				l.includes("details:") &&
				lines.some(
					(pl) => pl.includes("sendAgentResultMessage") && lines.indexOf(pl) < lines.indexOf(l),
				),
		);

		// Alternative: find by looking for the object after pi.sendMessage({... details: {...
		// Just search for the section with hasRawOutput — which should be removed
		const outputInDetails = lines.some(
			(l) =>
				l.includes("details:") &&
				(l.includes("rawOutput:") ||
					l.includes("output: result.output") ||
					l.includes("output: result.textOnly") ||
					l.includes("rawOutput: result.output")),
		);

		assert.ok(!outputInDetails, "sendAgentResultMessage must NOT pass rawOutput/output in details");
	});

	it("2.2: sendAgentResultMessage details no longer passes 'textOutput' field", () => {
		// Check that textOutput is not part of the details object
		const textOutputInDetails = lines.some(
			(l, i) =>
				l.includes("textOutput:") &&
				l.includes("result.textOutput") &&
				i < lines.findIndex((l2) => l2.includes("satisfies SupervisorMessageDetails")),
		);

		assert.ok(!textOutputInDetails, "sendAgentResultMessage must NOT pass textOutput in details");
	});

	it("2.3: sendAgentResultMessage details no longer passes 'textOnly' field", () => {
		const textOnlyInDetails = lines.some(
			(l) =>
				l.includes("textOnly:") && (l.includes("result.textOnly") || l.includes("result.textOnly")),
		);

		assert.ok(!textOnlyInDetails, "sendAgentResultMessage must NOT pass textOnly in details");
	});

	it("2.4: details still passes metadata fields (agentName, success, toolCount, etc.)", () => {
		// The essential metadata should still be present
		const hasAgentName = lines.some(
			(l) => l.includes("agentName:") && l.includes("result.agentName"),
		);
		const hasSuccess = lines.some((l) => l.includes("success:") && l.includes("result.success"));
		const hasSummary = lines.some(
			(l) => l.includes("summaryLine:") && l.includes("result.summaryLine"),
		);
		const hasToolCount = lines.some(
			(l) => l.includes("toolCount:") && l.includes("result.toolCount"),
		);

		assert.ok(hasAgentName, "agentName must still be in details");
		assert.ok(hasSuccess, "success must still be in details");
		assert.ok(hasSummary, "summaryLine must still be in details");
		assert.ok(hasToolCount, "toolCount must still be in details");
	});

	// ── 2.5: hasRawOutput removed from details ──

	it("2.5: 'hasRawOutput' field removed from details in sendAgentResultMessage", () => {
		const hasRawOutputInDetails = lines.some(
			(l) => l.includes("hasRawOutput:") && !l.trim().startsWith("//"),
		);
		assert.ok(
			!hasRawOutputInDetails,
			"sendAgentResultMessage must NOT pass hasRawOutput in details",
		);
	});

	// ── 2.6: hasThinking and thinkingOutput still passed (useful metadata) ──

	it("2.6: thinkingOutput and hasThinking still passed in details", () => {
		const hasThinkingOutput = lines.some(
			(l) => l.includes("thinkingOutput:") && l.includes("result.thinkingOutput"),
		);
		const hasHasThinking = lines.some((l) => l.includes("hasThinking:"));
		// thinking is smaller and useful for display — should be kept
		assert.ok(
			hasThinkingOutput,
			"thinkingOutput should still be passed in details (small metadata)",
		);
		assert.ok(hasHasThinking, "hasThinking should still be passed in details (small metadata)");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Source-structure — types.ts SupervisorMessageDetails update (Bug 1)
// ═══════════════════════════════════════════════════════════════════════

describe("Bug 1 — SupervisorMessageDetails interface update", () => {
	const source = readFileSync(".pi/extensions/supervisor/config/types.ts", "utf-8");

	// ── 3.1: rawOutput field removed or made optional ──

	it("3.1: rawOutput field removed or marked optional in SupervisorMessageDetails", () => {
		// Find the SupervisorMessageDetails interface
		const interfaceStart = source.indexOf("export interface SupervisorMessageDetails");
		assert.ok(interfaceStart >= 0, "SupervisorMessageDetails interface must exist");

		const interfaceBlock = source.slice(interfaceStart);
		// Extract the interface body
		const bodyStart = interfaceBlock.indexOf("{");
		const bodyEnd = interfaceBlock.indexOf("}");
		assert.ok(bodyStart >= 0, "Interface must have body");
		const body = interfaceBlock.slice(bodyStart + 1, bodyEnd);

		// Check for rawOutput — should be either removed or marked optional with ?
		const rawOutputLine = body.split("\n").find((l) => l.includes("rawOutput"));
		if (rawOutputLine) {
			// If it exists, it must be optional
			assert.ok(
				rawOutputLine.includes("?"),
				"rawOutput must be optional (marked with ?) if present: " + rawOutputLine.trim(),
			);
		}
		// If rawOutput is completely removed, also ok
	});

	it("3.2: textOutput field removed or marked optional in SupervisorMessageDetails", () => {
		const interfaceStart = source.indexOf("export interface SupervisorMessageDetails");
		const interfaceBlock = source.slice(interfaceStart);
		const bodyStart = interfaceBlock.indexOf("{");
		const bodyEnd = interfaceBlock.indexOf("}");
		const body = interfaceBlock.slice(bodyStart + 1, bodyEnd);

		const textOutputLine = body.split("\n").find((l) => l.includes("textOutput"));
		if (textOutputLine) {
			assert.ok(
				textOutputLine.includes("?"),
				"textOutput must be optional (marked with ?) if present: " + textOutputLine.trim(),
			);
		}
	});

	// ── 3.3: Small metadata fields retained ──

	it("3.3: agentName, summaryLine, toolCount, tokenCount, durationMs remain required", () => {
		const interfaceStart = source.indexOf("export interface SupervisorMessageDetails");
		const interfaceBlock = source.slice(interfaceStart);
		const bodyStart = interfaceBlock.indexOf("{");
		const bodyEnd = interfaceBlock.indexOf("}");
		const body = interfaceBlock.slice(bodyStart + 1, bodyEnd);

		assert.ok(body.includes("agentName"), "agentName must remain in SupervisorMessageDetails");
		assert.ok(body.includes("summaryLine"), "summaryLine must remain in SupervisorMessageDetails");
		assert.ok(body.includes("toolCount"), "toolCount must remain in SupervisorMessageDetails");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Unit mock tests for sendAgentResultMessage (Bug 1)
// ═══════════════════════════════════════════════════════════════════════

describe("Bug 1 — sendAgentResultMessage mock test", () => {
	it("4.1: sendAgentResultMessage details do NOT contain output/textOutput/textOnly", async () => {
		// Dynamic import to avoid TypeScript module resolution issues
		// We test the actual exported function
		let sendAgentResultMessage: any;
		try {
			const mod = await import("../pipeline/notifications.ts");
			sendAgentResultMessage = mod.sendAgentResultMessage;
		} catch {
			// If import fails (e.g. due to unresolved module dependencies),
			// fall back to source-structure verification
			const source = readFileSync(".pi/extensions/supervisor/pipeline/notifications.ts", "utf-8");
			const hasOutput = source.includes("rawOutput: result.output");
			const hasTextOutput = source.includes("textOutput: result.textOutput");
			const hasTextOnly = source.includes("textOnly: result.textOnly");
			assert.ok(!hasOutput, "result.output must not be in details");
			assert.ok(!hasTextOutput, "result.textOutput must not be in details");
			assert.ok(!hasTextOnly, "result.textOnly must not be in details");
			return;
		}

		// Create mock pi
		let sentMessage: any = null;
		const mockPi = {
			sendMessage: (msg: any) => {
				sentMessage = msg;
			},
		};

		// Call sendAgentResultMessage with full data
		sendAgentResultMessage(mockPi, {
			agentName: "developer",
			success: true,
			statusLabel: "SUCCESS",
			toolCount: 5,
			tokenCount: 1000,
			durationMs: 5000,
			textOutput: "this is a long text output that should NOT leak",
			textOnly: "this is text-only output that should NOT leak",
			output: "this is raw output up to 100K chars that should NOT leak",
			summaryLine: "completed task",
			thinkingOutput: "deep thoughts",
		});

		assert.ok(sentMessage, "pi.sendMessage must have been called");
		assert.ok(sentMessage.details, "details must exist");

		// Verify large fields are NOT in details
		assert.equal(sentMessage.details.textOutput, undefined, "textOutput must NOT be in details");
		assert.equal(sentMessage.details.textOnly, undefined, "textOnly must NOT be in details");
		assert.equal(sentMessage.details.rawOutput, undefined, "rawOutput must NOT be in details");
		assert.equal(sentMessage.details.output, undefined, "output must NOT be in details");

		// Verify metadata IS still in details
		assert.equal(sentMessage.details.agentName, "developer");
		assert.equal(sentMessage.details.success, true);
		assert.equal(sentMessage.details.summaryLine, "completed task");

		// Verify thinking output IS still in details (small metadata)
		assert.equal(sentMessage.details.thinkingOutput, "deep thoughts");
	});

	it("4.2: sendAgentResultMessage details contains hasThinking for UI renderer", async () => {
		let sendAgentResultMessage: any;
		try {
			const mod = await import("../pipeline/notifications.ts");
			sendAgentResultMessage = mod.sendAgentResultMessage;
		} catch {
			// Source structure fallback
			const source = readFileSync(".pi/extensions/supervisor/pipeline/notifications.ts", "utf-8");
			assert.ok(source.includes("hasThinking"), "hasThinking should be in details for UI renderer");
			return;
		}

		let sentMessage: any = null;
		const mockPi = {
			sendMessage: (msg: any) => {
				sentMessage = msg;
			},
		};

		sendAgentResultMessage(mockPi, {
			agentName: "developer",
			success: true,
			statusLabel: "SUCCESS",
			toolCount: 3,
			tokenCount: 500,
			durationMs: 3000,
			textOutput: "",
			textOnly: "",
			output: "",
			summaryLine: "done",
			thinkingOutput: "thinking text",
		});

		assert.ok(sentMessage, "pi.sendMessage must have been called");
		assert.ok(sentMessage.details, "details must exist");
		assert.equal(
			sentMessage.details.hasThinking,
			true,
			"hasThinking should be true when thinkingOutput is present",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: Source-structure — pipeline/handler.ts (Bug 1 — call site)
// ═══════════════════════════════════════════════════════════════════════

describe("Bug 1 — Pipeline handler passes result data through agentResults", () => {
	const source = readFileSync(".pi/extensions/supervisor/pipeline/handler.ts", "utf-8");

	it("5.1: handler passes result data via buildAgentResultEntry and executeAgent", () => {
		// Handler no longer calls sendAgentResultMessage directly — executeAgent
		// handles messaging internally via pi.sendMessage with _subagentResult details.
		// The handler still tracks results via buildAgentResultEntry
		const hasBuildAgentEntry = source.includes("buildAgentResultEntry(result");
		const hasExecuteAgent = source.includes("await executeAgent(");
		const hasResultDestructure = source.includes(
			"const { result, usedRetry } = await executeAgent(",
		);

		assert.ok(hasExecuteAgent, "handler should call executeAgent");
		assert.ok(hasResultDestructure, "handler destructures result from executeAgent");
		assert.ok(hasBuildAgentEntry, "handler passes result to buildAgentResultEntry");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: Source-structure — message-renderer.ts (uses updated interface)
// ═══════════════════════════════════════════════════════════════════════

describe("Bug 1 — Message renderer resilience with optional fields", () => {
	const source = readFileSync(".pi/extensions/supervisor/session/message-renderer.ts", "utf-8");

	it("6.1: textOutput is accessed with truthy guard (not assumed required)", () => {
		// The renderer should guard against optional textOutput
		const hasGuard =
			source.includes("if (details.textOutput)") || source.includes("if (details?.textOutput)");
		assert.ok(
			hasGuard,
			"Message renderer must guard textOutput with truthy check (optional field)",
		);
	});

	it("6.2: rawOutput is accessed with hasRawOutput guard", () => {
		// The renderer should guard rawOutput with hasRawOutput check
		const hasGuard = source.includes("hasRawOutput") && source.includes("rawOutput");
		assert.ok(hasGuard, "Message renderer must guard rawOutput with hasRawOutput check");
	});
});
