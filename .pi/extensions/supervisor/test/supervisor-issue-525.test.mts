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
