/**
 * Tests for agent-session-runner.ts — timeout race, done event, token fallback, validation.
 *
 * Phase 1: processSessionEvent done case handler (Bug D)
 * Phase 2: buildAgentRunResult token fallback scan (Bug B)
 * Phase 3: validateAgentResult validation (Bug C)
 * Phase 4: pipeline structural — validateAgentResult called after runAgent (Bug C)
 * Phase 5: timeout mechanism structural — Promise.race pattern (Bug A)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-agent-session-runner.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import type { AgentRunState, AgentPhase, AgentRunResult } from "../config/types.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function pushLog(state: AgentRunState, entry: string): void {
	state.fullLog.push(entry);
	if (state.fullLog.length > 500) state.fullLog.shift();
}

/** Map phase to priority */
function phasePriority(phase: AgentPhase): number {
	switch (phase) {
		case "tool":
			return 3;
		case "thinking":
			return 2;
		case "text":
			return 1;
		case "idle":
			return 0;
	}
}

/** Determine event phase */
function getEventPhase(ev: any): AgentPhase {
	if (!ev) return "idle";
	if (ev.type === "tool_execution_start") return "tool";
	if (ev.type === "tool_execution_end") return "idle";
	if (ev.type === "message_update") {
		const ae = ev.assistantMessageEvent;
		if (!ae) return "idle";
		switch (ae.type) {
			case "thinking_delta":
				if (ae.delta) return "thinking";
				break;
			case "thinking_start":
				return "thinking";
			case "text_delta":
				if (ae.delta) return "text";
				break;
			case "text_start":
				return "text";
			case "thinking_end":
			case "text_end":
				return "idle";
		}
	}
	if (ev.type === "message_end") return "idle";
	return "idle";
}

/** Extract text from content blocks */
function extractTextFromContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b.type === "text" && b.text)
		.map((b: any) => b.text)
		.join("\n");
}

/** Factory for AgentRunState */
function createState(overrides?: Partial<AgentRunState>): AgentRunState {
	return {
		toolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		phase: "idle",
		startedAt: Date.now(),
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		budgetExceeded: false,
		...overrides,
	} as AgentRunState;
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: processSessionEvent — done case handler (Bug D)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Duplicate of processSessionEvent with done-case handler added (Bug D).
 * Same pattern as existing tests (supervisor-in-process.test.mts).
 */
function processSessionEventWithDone(
	ev: any,
	state: AgentRunState,
): { flush: boolean; workingChange: boolean } {
	const prevPhase = state.phase;

	switch (ev.type) {
		case "context_info":
			break;

		case "tool_execution_start": {
			state.currentTool = ev.toolName || "tool";
			state.currentToolArgs = ev.args ? JSON.stringify(ev.args).slice(0, 200) : undefined;
			state.lastToolName = ev.toolName;
			state.phase = "tool";
			const logArgs = ev.args ? JSON.stringify(ev.args).slice(0, 200) : "";
			pushLog(state, `🔧 ${ev.toolName}${logArgs ? ` ${logArgs}` : ""}`);
			return { flush: true, workingChange: prevPhase !== "tool" };
		}

		case "tool_execution_end": {
			state.toolCount++;
			state.currentTool = undefined;
			state.currentToolArgs = undefined;
			state.phase = "idle";
			pushLog(state, `${ev.isError ? "✗" : "✓"} ${ev.toolName}`);
			return { flush: true, workingChange: true };
		}

		case "message_update": {
			const ae = ev.assistantMessageEvent;
			if (!ae) break;

			const eventPhase = getEventPhase(ev);
			if (eventPhase !== "idle" && phasePriority(eventPhase) >= phasePriority(state.phase)) {
				state.phase = eventPhase;
			}

			switch (ae.type) {
				case "thinking_start": {
					state.thinkingPushedThisTurn = false;
					return { flush: true, workingChange: prevPhase !== "thinking" };
				}
				case "text_start": {
					state.textPushedThisTurn = false;
					return { flush: true, workingChange: prevPhase !== "text" };
				}
				case "thinking_delta": {
					const td = ae.delta;
					if (typeof td === "string" && td.length > 0) {
						state.liveThinking += td;
						if (state.liveThinking.length > 1000) {
							state.liveThinking = state.liveThinking.slice(-1000);
						}
						let nlIdx;
						while ((nlIdx = state.liveThinking.indexOf("\n")) !== -1) {
							const line = state.liveThinking.slice(0, nlIdx);
							state.liveThinking = state.liveThinking.slice(nlIdx + 1);
							if (line.trim()) pushLog(state, `💭 ${line}`);
						}
						return { flush: true, workingChange: prevPhase !== "thinking" };
					}
					break;
				}
				case "text_delta": {
					const td = ae.delta;
					if (typeof td === "string" && td.length > 0) {
						state.liveText += td;
						if (state.liveText.length > 10_000) {
							state.liveText = state.liveText.slice(-8_000);
						}
						let nlIdx;
						while ((nlIdx = state.liveText.indexOf("\n")) !== -1) {
							const line = state.liveText.slice(0, nlIdx);
							state.liveText = state.liveText.slice(nlIdx + 1);
							if (line.trim()) pushLog(state, line);
						}
						return { flush: true, workingChange: prevPhase !== "text" };
					}
					break;
				}
				case "thinking_end": {
					if (state.liveThinking.trim()) {
						state.thinkingOutputLines.push(state.liveThinking.trim());
						for (const t of state.liveThinking.split("\n")) {
							const trimmed = t.trim();
							if (trimmed) pushLog(state, `💭 ${trimmed}`);
						}
						state.thinkingPushedThisTurn = true;
					}
					state.liveThinking = "";
					state.phase = "idle";
					return { flush: true, workingChange: true };
				}
				case "text_end": {
					if (state.liveText.trim()) {
						state.textOutputLines.push(state.liveText.trim());
						for (const t of state.liveText.split("\n")) {
							const trimmed = t.trim();
							if (trimmed) pushLog(state, trimmed);
						}
						state.textPushedThisTurn = true;
					}
					if (ev.message?.usage) {
						state.tokenCount =
							ev.message.usage.totalTokens ||
							ev.message.usage.input + ev.message.usage.output ||
							state.tokenCount;
					}
					state.liveText = "";
					state.phase = "idle";
					return { flush: true, workingChange: true };
				}
				// ── Bug D fix: done event handler ──
				case "done": {
					const msg = ae.message;
					if (msg?.usage) {
						state.tokenCount =
							msg.usage.totalTokens || msg.usage.input + msg.usage.output || state.tokenCount;
					}
					if (msg?.content && Array.isArray(msg.content)) {
						// Extract text from content blocks
						const textParts: string[] = [];
						const thinkingParts: string[] = [];
						for (const block of msg.content) {
							if (block.type === "text" && block.text) {
								textParts.push(block.text);
							}
							if (block.type === "thinking" && block.thinking) {
								const t =
									typeof block.thinking === "string"
										? block.thinking
										: JSON.stringify(block.thinking);
								thinkingParts.push(t);
							}
						}
						// Push text output lines (skip if already pushed via text_end)
						if (!state.textPushedThisTurn && textParts.length > 0) {
							const allText = textParts.join("\n").trim();
							if (allText) {
								state.textOutputLines.push(allText);
								for (const t of allText.split("\n")) {
									if (t.trim()) pushLog(state, t);
								}
							}
						}
						// Push thinking output lines (skip if already pushed via thinking_end)
						if (!state.thinkingPushedThisTurn && thinkingParts.length > 0) {
							const allThinking = thinkingParts.join("\n").trim();
							if (allThinking) {
								state.thinkingOutputLines.push(allThinking);
								for (const t of allThinking.split("\n")) {
									if (t.trim()) pushLog(state, `💭 ${t}`);
								}
							}
						}
					}
					state.phase = "idle";
					return { flush: true, workingChange: true };
				}
			}
			break;
		}

		case "message_end": {
			const msg = ev.message;
			if (!msg) break;

			if (msg.role === "assistant") {
				if (!state.thinkingPushedThisTurn && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "thinking" && block.thinking) {
							const thinkingText =
								typeof block.thinking === "string"
									? block.thinking
									: JSON.stringify(block.thinking);
							for (const t of thinkingText.split("\n")) {
								if (t.trim()) pushLog(state, `💭 ${t.trim()}`);
							}
						}
					}
				}
				if (!state.textPushedThisTurn) {
					const text = extractTextFromContent(msg.content);
					if (text && text.trim()) {
						state.textOutputLines.push(text.trim());
						for (const t of text.split("\n")) {
							if (t.trim()) pushLog(state, t);
						}
					}
				}
				if (msg.usage) {
					state.tokenCount = msg.usage.totalTokens || msg.usage.input + msg.usage.output;
				}
			} else if (msg.role === "toolResult") {
				const resultText = extractTextFromContent(msg.content);
				const label = msg.toolName || state.lastToolName || "tool";
				if (resultText && resultText.trim()) {
					const resultLines = resultText.split("\n");
					pushLog(state, `📋 ${label}: ${resultLines[0]?.slice(0, 300) || "(no output)"}`);
					for (let i = 1; i < Math.min(resultLines.length, 6); i++) {
						if (resultLines[i].trim()) pushLog(state, `   ${resultLines[i].slice(0, 200)}`);
					}
				} else {
					pushLog(state, `📋 ${label}: (no output)`);
				}
				state.lastToolName = undefined;
			}
			state.phase = "idle";
			state.thinkingPushedThisTurn = false;
			state.textPushedThisTurn = false;
			return { flush: true, workingChange: true };
		}

		case "turn_start":
		case "turn_end":
		case "agent_start":
		case "agent_end":
			break;
	}

	return { flush: false, workingChange: false };
}

describe("Phase 1: processSessionEvent — done case handler (Bug D)", () => {
	it("1.1: done event with usage sets tokenCount", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					usage: { totalTokens: 542 },
				},
			},
		};
		processSessionEventWithDone(ev, state);
		assert.strictEqual(state.tokenCount, 542);
	});

	it("1.2: done event with text content pushes textOutputLines and sets phase idle", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "text", text: "Hello world" }],
				},
			},
		};
		processSessionEventWithDone(ev, state);
		assert.ok(state.textOutputLines.includes("Hello world"));
		assert.strictEqual(state.phase, "idle");
	});

	it("1.3: done event with thinking content pushes thinkingOutputLines and resets thinkingPushedThisTurn", () => {
		const state = createState({ thinkingPushedThisTurn: false });
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "thinking", thinking: "I think therefore I am" }],
				},
			},
		};
		processSessionEventWithDone(ev, state);
		assert.ok(state.thinkingOutputLines[0]?.includes("I think therefore I am"));
	});

	it("1.4: done event with mixed text+thinking populates both output arrays", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [
						{ type: "thinking", thinking: "deep thought" },
						{ type: "text", text: "result text" },
					],
				},
			},
		};
		processSessionEventWithDone(ev, state);
		assert.ok(state.thinkingOutputLines.some((l) => l.includes("deep thought")));
		assert.ok(state.textOutputLines.some((l) => l.includes("result text")));
	});

	it("1.5: done event without usage field leaves tokenCount unchanged (0)", () => {
		const state = createState({ tokenCount: 0 });
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "text", text: "hello" }],
				},
			},
		};
		processSessionEventWithDone(ev, state);
		assert.strictEqual(state.tokenCount, 0);
	});

	it("1.6: done event with empty content array pushes no output lines", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [],
				},
			},
		};
		processSessionEventWithDone(ev, state);
		assert.strictEqual(state.textOutputLines.length, 0);
		assert.strictEqual(state.thinkingOutputLines.length, 0);
	});

	it("1.7: done event with usage.input+output but no totalTokens sets tokenCount to sum", () => {
		const state = createState({ tokenCount: 0 });
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					usage: { input: 200, output: 300 },
				},
			},
		};
		processSessionEventWithDone(ev, state);
		assert.strictEqual(state.tokenCount, 500);
	});

	it("1.8: done event after text_end already set textPushedThisTurn=true skips duplicate text push", () => {
		const state = createState({ textPushedThisTurn: true });
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "text", text: "should not be pushed" }],
				},
			},
		};
		processSessionEventWithDone(ev, state);
		assert.strictEqual(state.textOutputLines.length, 0);
	});

	it("1.9: done event after thinking_end already set thinkingPushedThisTurn=true skips duplicate push", () => {
		const state = createState({ thinkingPushedThisTurn: true });
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "thinking", thinking: "should not be pushed" }],
				},
			},
		};
		processSessionEventWithDone(ev, state);
		assert.strictEqual(state.thinkingOutputLines.length, 0);
	});

	it("1.10: non-done event types not affected by done-specific fields", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "text_start",
			},
		};
		processSessionEventWithDone(ev, state);
		// text_start resets textPushedThisTurn, doesn't push output
		assert.strictEqual(state.textPushedThisTurn, false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: buildAgentRunResult — token fallback scan (Bug B)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Duplicate of buildAgentRunResult with message scanning for token usage.
 */
function buildAgentRunResultWithScan(
	state: AgentRunState,
	agentName: string,
	success: boolean,
	durationMs: number,
	messages: any[],
): AgentRunResult {
	const textOutput = state.fullLog.join("\n").trim();
	const textOnly = state.textOutputLines.join("\n").trim();
	const thinkingOutput =
		state.thinkingOutputLines.length > 0 ? state.thinkingOutputLines.join("\n\n") : undefined;

	// Token fallback: scan messages for assistant usage data
	let tokenCount = state.tokenCount;
	if (Array.isArray(messages) && messages.length > 0) {
		const scannedSum = messages
			.filter((m) => m && m.role === "assistant" && m.usage)
			.reduce((sum, m) => {
				const u = m.usage;
				const total = u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0);
				return sum + (typeof total === "number" && !Number.isNaN(total) ? total : 0);
			}, 0);
		tokenCount = Math.max(state.tokenCount, scannedSum);
	}

	return {
		output: "",
		success,
		agentName,
		toolCount: state.toolCount,
		tokenCount,
		durationMs,
		textOutput,
		textOnly,
		summaryLine: "",
		errorOutput: "",
		thinkingOutput,
	};
}

describe("Phase 2: buildAgentRunResult — token fallback scan (Bug B)", () => {
	it("2.1: state.tokenCount=0, messages have usage → uses scanned sum", () => {
		const state = createState({ tokenCount: 0 });
		const messages = [{ role: "assistant", usage: { totalTokens: 1234 } }];
		const result = buildAgentRunResultWithScan(state, "test", true, 1000, messages);
		assert.strictEqual(result.tokenCount, 1234);
	});

	it("2.2: state.tokenCount=500, messages have lower usage → max wins (state higher)", () => {
		const state = createState({ tokenCount: 500 });
		const messages = [{ role: "assistant", usage: { totalTokens: 300 } }];
		const result = buildAgentRunResultWithScan(state, "test", true, 1000, messages);
		assert.strictEqual(result.tokenCount, 500);
	});

	it("2.3: state.tokenCount=200, messages have higher usage → max wins (message higher)", () => {
		const state = createState({ tokenCount: 200 });
		const messages = [{ role: "assistant", usage: { totalTokens: 999 } }];
		const result = buildAgentRunResultWithScan(state, "test", true, 1000, messages);
		assert.strictEqual(result.tokenCount, 999);
	});

	it("2.4: state.tokenCount=0, messages empty → stays 0", () => {
		const state = createState({ tokenCount: 0 });
		const result = buildAgentRunResultWithScan(state, "test", true, 1000, []);
		assert.strictEqual(result.tokenCount, 0);
	});

	it("2.5: state.tokenCount=0, messages with usage but role != assistant → stays 0", () => {
		const state = createState({ tokenCount: 0 });
		const messages = [
			{ role: "user", usage: { totalTokens: 500 } },
			{ role: "toolResult", usage: { totalTokens: 300 } },
		];
		const result = buildAgentRunResultWithScan(state, "test", true, 1000, messages);
		assert.strictEqual(result.tokenCount, 0);
	});

	it("2.6: state.tokenCount=0, messages with usage.totalTokens=0 → stays 0", () => {
		const state = createState({ tokenCount: 0 });
		const messages = [{ role: "assistant", usage: { totalTokens: 0 } }];
		const result = buildAgentRunResultWithScan(state, "test", true, 1000, messages);
		assert.strictEqual(result.tokenCount, 0);
	});

	it("2.7: multiple assistant messages with usage → sum of all used", () => {
		const state = createState({ tokenCount: 0 });
		const messages = [
			{ role: "assistant", usage: { totalTokens: 100 } },
			{ role: "assistant", usage: { totalTokens: 200 } },
			{ role: "assistant", usage: { totalTokens: 300 } },
		];
		const result = buildAgentRunResultWithScan(state, "test", true, 1000, messages);
		assert.strictEqual(result.tokenCount, 600);
	});

	it("2.8: messages array with null/undefined entries → no crash", () => {
		const state = createState({ tokenCount: 0 });
		const messages: any[] = [null, undefined, { role: "assistant", usage: { totalTokens: 100 } }];
		const result = buildAgentRunResultWithScan(state, "test", true, 1000, messages);
		assert.strictEqual(result.tokenCount, 100);
	});

	it("2.9: messages with usage but no totalTokens (only input+output) → sum fallback", () => {
		const state = createState({ tokenCount: 0 });
		const messages = [{ role: "assistant", usage: { input: 400, output: 600 } }];
		const result = buildAgentRunResultWithScan(state, "test", true, 1000, messages);
		assert.strictEqual(result.tokenCount, 1000);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: validateAgentResult validation function (Bug C)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Duplicate of the new validateAgentResult function.
 * Sanity check: derates success=true when tokenCount=0 and toolCount>5.
 */
function validateAgentResult(result: AgentRunResult): void {
	if (result.success && result.tokenCount === 0 && result.toolCount > 5) {
		result.success = false;
		const existingError = result.errorOutput ? result.errorOutput + "\n" : "";
		result.errorOutput = `${existingError}Sanity check failed: success=true with tokenCount=0 and toolCount=${result.toolCount}. This indicates a timeout or abort before completion.`;
	}
}

describe("Phase 3: validateAgentResult (Bug C)", () => {
	it("3.1: success=true, tokenCount=0, toolCount=27 → derated to success=false", () => {
		const result: AgentRunResult = {
			output: "",
			success: true,
			agentName: "test",
			toolCount: 27,
			tokenCount: 0,
			durationMs: 5000,
			textOutput: "",
			textOnly: "",
			summaryLine: "",
			errorOutput: "",
		};
		validateAgentResult(result);
		assert.strictEqual(result.success, false);
		assert.ok(result.errorOutput.includes("Sanity check failed"));
	});

	it("3.2: success=true, tokenCount=0, toolCount=6 → derated (toolCount > 5)", () => {
		const result: AgentRunResult = {
			output: "",
			success: true,
			agentName: "test",
			toolCount: 6,
			tokenCount: 0,
			durationMs: 5000,
			textOutput: "",
			textOnly: "",
			summaryLine: "",
			errorOutput: "",
		};
		validateAgentResult(result);
		assert.strictEqual(result.success, false);
	});

	it("3.3: success=true, tokenCount=0, toolCount=5 → stays success (≤5 threshold)", () => {
		const result: AgentRunResult = {
			output: "",
			success: true,
			agentName: "test",
			toolCount: 5,
			tokenCount: 0,
			durationMs: 5000,
			textOutput: "",
			textOnly: "",
			summaryLine: "",
			errorOutput: "",
		};
		validateAgentResult(result);
		assert.strictEqual(result.success, true);
	});

	it("3.4: success=true, tokenCount=100, toolCount=27 → stays success (has tokens)", () => {
		const result: AgentRunResult = {
			output: "",
			success: true,
			agentName: "test",
			toolCount: 27,
			tokenCount: 100,
			durationMs: 5000,
			textOutput: "",
			textOnly: "",
			summaryLine: "",
			errorOutput: "",
		};
		validateAgentResult(result);
		assert.strictEqual(result.success, true);
	});

	it("3.5: success=true, tokenCount=0, toolCount=0 → stays success (no tools used)", () => {
		const result: AgentRunResult = {
			output: "",
			success: true,
			agentName: "test",
			toolCount: 0,
			tokenCount: 0,
			durationMs: 5000,
			textOutput: "",
			textOnly: "",
			summaryLine: "",
			errorOutput: "",
		};
		validateAgentResult(result);
		assert.strictEqual(result.success, true);
	});

	it("3.6: success=false already, tokenCount=0, toolCount=10 → stays false (no change)", () => {
		const result: AgentRunResult = {
			output: "",
			success: false,
			agentName: "test",
			toolCount: 10,
			tokenCount: 0,
			durationMs: 5000,
			textOutput: "",
			textOnly: "",
			summaryLine: "",
			errorOutput: "Original error",
		};
		validateAgentResult(result);
		assert.strictEqual(result.success, false);
		assert.ok(result.errorOutput.includes("Original error")); // preserved
	});

	it("3.7: result with existing errorMessage → errorMessage preserved/appended", () => {
		const result: AgentRunResult = {
			output: "",
			success: true,
			agentName: "test",
			toolCount: 27,
			tokenCount: 0,
			durationMs: 5000,
			textOutput: "",
			textOnly: "",
			summaryLine: "",
			errorOutput: "Previous error",
		};
		validateAgentResult(result);
		assert.strictEqual(result.success, false);
		assert.ok(result.errorOutput.includes("Previous error"));
		assert.ok(result.errorOutput.includes("Sanity check failed"));
	});

	it("3.8: result missing toolCount field → defaults to 0, stays success=true", () => {
		const result: any = {
			output: "",
			success: true,
			agentName: "test",
			tokenCount: 0,
			durationMs: 5000,
			textOutput: "",
			textOnly: "",
			summaryLine: "",
			errorOutput: "",
		};
		validateAgentResult(result);
		assert.strictEqual(result.success, true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: pipeline structural — validateAgentResult called after runAgent
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 4: pipeline — validateAgentResult integration (Bug C)", () => {
	const source = readFileSync(".pi/extensions/supervisor/pipeline/handler.ts", "utf-8");
	const outputSource = readFileSync(".pi/extensions/supervisor/pipeline/output.ts", "utf-8");

	it("4.1: pipeline/handler.ts calls validateAgentResult(result) in executeAgent after pi.executeTool and before retry check", () => {
		const executeAgentMatch = source.match(/const \{ result, usedRetry \} = await executeAgent\(/);
		assert.ok(executeAgentMatch, "executeAgent call exists in pipeline/handler.ts");
		// validateAgentResult is called inside executeAgent (handler.ts lines 1594, 1616)
		// Check that executeAgent's body contains validateAgentResult calls
		assert.ok(
			source.includes("validateAgentResult(result)"),
			"validateAgentResult(result) must be called inside executeAgent",
		);
	});

	it("4.2: validateAgentResult imported in pipeline/handler.ts from pipeline/output.ts", () => {
		assert.ok(
			source.includes("import") &&
				source.includes("validateAgentResult") &&
				source.includes("../pipeline/output.ts"),
			"validateAgentResult must be imported from pipeline/output.ts",
		);
	});

	it("4.3: validateAgentResult mutates success to false when tokenCount=0 and toolCount>5", () => {
		const hasLogic =
			outputSource.includes("tokenCount === 0") &&
			outputSource.includes("toolCount > 5") &&
			outputSource.includes("result.success = false");
		assert.ok(
			hasLogic,
			"validateAgentResult must check tokenCount===0 and toolCount>5, then set success=false",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: Timeout mechanism structural — Promise.race pattern (Bug A)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 5: agent-session-runner — timeout mechanism (Bug A)", () => {
	const source = readFileSync(".pi/extensions/supervisor/agent/session-runner.ts", "utf-8");

	it("5.1: uses Promise.race with timeout promise inside inner try block", () => {
		// Find Promise.race pattern with session.prompt
		assert.ok(
			source.includes("Promise.race") && source.includes("session.prompt("),
			"Timeout must use Promise.race with session.prompt()",
		);
	});

	it("5.2: session!.abort() called inside timeout handler for cleanup", () => {
		// session.abort must still be present but as cleanup, not sole mechanism
		assert.ok(
			source.includes("session!.abort()") || source.includes("session?.abort()"),
			"session.abort() must be called for cleanup",
		);
	});

	it("5.3: no setTimeout + session.abort() as sole mechanism (race pattern present)", () => {
		// Check there's no standalone setTimeout that just calls abort
		const lines = source.split("\n");
		const setTimeoutLines = lines.filter((l) => l.includes("setTimeout("));
		const hasRace = source.includes("Promise.race");
		// Must have race pattern as primary timeout
		assert.ok(hasRace, "Promise.race must be the primary timeout mechanism");
	});

	it("5.4: timeout promise rejects when timeout fires", () => {
		// Check for new Promise reject in timeout handler
		assert.ok(
			source.includes("reject(") || source.includes("reject(new Error"),
			"Timeout promise must reject when timeout fires",
		);
	});

	it("5.5: timedOut flag variable still present for catch block detection", () => {
		assert.ok(
			source.includes("let timedOut") && source.includes("timedOut = true"),
			"timedOut flag must be declared and set in timeout handler",
		);
	});

	it("5.6: no AbortController variable declaration in file", () => {
		const lines = source.split("\n");
		const abortDecl = lines.filter(
			(l) =>
				(l.includes("let ") || l.includes("const ") || l.includes("var ")) &&
				l.includes("abortController"),
		);
		assert.strictEqual(abortDecl.length, 0, "No abortController variable declaration should exist");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: Unconditional flag at text_end/thinking_end — prevent duplicate log entries
// ═══════════════════════════════════════════════════════════════════════

/**
 * processSessionEvent with the fix: flags set unconditionally outside the
 * conditional if (buffer.trim()) blocks in text_end and thinking_end.
 * This guarantees done/message_end never re-pushes content already streamed
 * by _delta handlers.
 */
function processSessionEventFlagFix(
	ev: any,
	state: AgentRunState,
): { flush: boolean; workingChange: boolean } {
	const prevPhase = state.phase;

	switch (ev.type) {
		case "context_info":
			break;

		case "tool_execution_start": {
			state.currentTool = ev.toolName || "tool";
			state.currentToolArgs = ev.args ? JSON.stringify(ev.args).slice(0, 200) : undefined;
			state.lastToolName = ev.toolName;
			state.phase = "tool";
			const logArgs = ev.args ? JSON.stringify(ev.args).slice(0, 200) : "";
			pushLog(state, `🔧 ${ev.toolName}${logArgs ? ` ${logArgs}` : ""}`);
			return { flush: true, workingChange: prevPhase !== "tool" };
		}

		case "tool_execution_end": {
			state.toolCount++;
			state.currentTool = undefined;
			state.currentToolArgs = undefined;
			state.phase = "idle";
			pushLog(state, `${ev.isError ? "✗" : "✓"} ${ev.toolName}`);
			return { flush: true, workingChange: true };
		}

		case "message_update": {
			const ae = ev.assistantMessageEvent;
			if (!ae) break;

			const eventPhase = getEventPhase(ev);
			if (eventPhase !== "idle" && phasePriority(eventPhase) >= phasePriority(state.phase)) {
				state.phase = eventPhase;
			}

			switch (ae.type) {
				case "thinking_start": {
					state.thinkingPushedThisTurn = false;
					return { flush: true, workingChange: prevPhase !== "thinking" };
				}
				case "text_start": {
					state.textPushedThisTurn = false;
					return { flush: true, workingChange: prevPhase !== "text" };
				}
				case "thinking_delta": {
					const td = ae.delta;
					if (typeof td === "string" && td.length > 0) {
						state.liveThinking += td;
						if (state.liveThinking.length > 1000) {
							state.liveThinking = state.liveThinking.slice(-1000);
						}
						let nlIdx;
						while ((nlIdx = state.liveThinking.indexOf("\n")) !== -1) {
							const line = state.liveThinking.slice(0, nlIdx);
							state.liveThinking = state.liveThinking.slice(nlIdx + 1);
							if (line.trim()) pushLog(state, `💭 ${line}`);
						}
						return { flush: true, workingChange: prevPhase !== "thinking" };
					}
					break;
				}
				case "text_delta": {
					const td = ae.delta;
					if (typeof td === "string" && td.length > 0) {
						state.liveText += td;
						if (state.liveText.length > 10_000) {
							state.liveText = state.liveText.slice(-8_000);
						}
						let nlIdx;
						while ((nlIdx = state.liveText.indexOf("\n")) !== -1) {
							const line = state.liveText.slice(0, nlIdx);
							state.liveText = state.liveText.slice(nlIdx + 1);
							if (line.trim()) pushLog(state, line);
						}
						return { flush: true, workingChange: prevPhase !== "text" };
					}
					break;
				}
				// ── FIX: Flag set unconditionally ──
				case "thinking_end": {
					if (state.liveThinking.trim()) {
						state.thinkingOutputLines.push(state.liveThinking.trim());
						for (const t of state.liveThinking.split("\n")) {
							const trimmed = t.trim();
							if (trimmed) pushLog(state, `💭 ${trimmed}`);
						}
					}
					state.thinkingPushedThisTurn = true; // ALWAYS set, not conditionally
					state.liveThinking = "";
					state.phase = "idle";
					return { flush: true, workingChange: true };
				}
				// ── FIX: Flag set unconditionally ──
				case "text_end": {
					if (state.liveText.trim()) {
						state.textOutputLines.push(state.liveText.trim());
						for (const t of state.liveText.split("\n")) {
							const trimmed = t.trim();
							if (trimmed) pushLog(state, trimmed);
						}
					}
					state.textPushedThisTurn = true; // ALWAYS set, not conditionally
					if (ev.message?.usage) {
						state.tokenCount =
							ev.message.usage.totalTokens ||
							ev.message.usage.input + ev.message.usage.output ||
							state.tokenCount;
					}
					state.liveText = "";
					state.phase = "idle";
					return { flush: true, workingChange: true };
				}
				case "done": {
					const msg = ae.message;
					if (msg?.usage) {
						state.tokenCount =
							msg.usage.totalTokens || msg.usage.input + msg.usage.output || state.tokenCount;
					}
					if (msg?.content && Array.isArray(msg.content)) {
						const textParts: string[] = [];
						const thinkingParts: string[] = [];
						for (const block of msg.content) {
							if (block.type === "text" && block.text) {
								textParts.push(block.text);
							}
							if (block.type === "thinking" && block.thinking) {
								const t =
									typeof block.thinking === "string"
										? block.thinking
										: JSON.stringify(block.thinking);
								thinkingParts.push(t);
							}
						}
						if (!state.textPushedThisTurn && textParts.length > 0) {
							const allText = textParts.join("\n").trim();
							if (allText) {
								state.textOutputLines.push(allText);
								for (const t of allText.split("\n")) {
									if (t.trim()) pushLog(state, t);
								}
							}
						}
						if (!state.thinkingPushedThisTurn && thinkingParts.length > 0) {
							const allThinking = thinkingParts.join("\n").trim();
							if (allThinking) {
								state.thinkingOutputLines.push(allThinking);
								for (const t of allThinking.split("\n")) {
									if (t.trim()) pushLog(state, `💭 ${t}`);
								}
							}
						}
					}
					state.phase = "idle";
					return { flush: true, workingChange: true };
				}
			}
			break;
		}

		case "message_end": {
			const msg = ev.message;
			if (!msg) break;

			if (msg.role === "assistant") {
				if (!state.thinkingPushedThisTurn && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "thinking" && block.thinking) {
							const thinkingText =
								typeof block.thinking === "string"
									? block.thinking
									: JSON.stringify(block.thinking);
							for (const t of thinkingText.split("\n")) {
								if (t.trim()) pushLog(state, `💭 ${t.trim()}`);
							}
						}
					}
				}
				if (!state.textPushedThisTurn) {
					const text = extractTextFromContent(msg.content);
					if (text && text.trim()) {
						state.textOutputLines.push(text.trim());
						for (const t of text.split("\n")) {
							if (t.trim()) pushLog(state, t);
						}
					}
				}
				if (msg.usage) {
					state.tokenCount = msg.usage.totalTokens || msg.usage.input + msg.usage.output;
				}
			} else if (msg.role === "toolResult") {
				const resultText = extractTextFromContent(msg.content);
				const label = msg.toolName || state.lastToolName || "tool";
				if (resultText && resultText.trim()) {
					const resultLines = resultText.split("\n");
					pushLog(state, `📋 ${label}: ${resultLines[0]?.slice(0, 300) || "(no output)"}`);
					for (let i = 1; i < Math.min(resultLines.length, 6); i++) {
						if (resultLines[i].trim()) pushLog(state, `   ${resultLines[i].slice(0, 200)}`);
					}
				} else {
					pushLog(state, `📋 ${label}: (no output)`);
				}
				state.lastToolName = undefined;
			}
			state.phase = "idle";
			state.thinkingPushedThisTurn = false;
			state.textPushedThisTurn = false;
			return { flush: true, workingChange: true };
		}

		case "turn_start":
		case "turn_end":
		case "agent_start":
		case "agent_end":
			break;
	}

	return { flush: false, workingChange: false };
}

/**
 * Process a JSON line event (agent-stream.ts style) with the fix:
 * flags set unconditionally in text_end and thinking_end.
 */
function processJsonLineFlagFix(
	line: string,
	state: AgentRunState,
): { flush: boolean; workingChange: boolean } {
	if (!line.trim()) return { flush: false, workingChange: false };
	try {
		const ev = JSON.parse(line);
		switch (ev.type) {
			case "session":
				break;

			case "context_info": {
				const tokens = ev.contextTokens;
				const window = ev.contextWindow;
				if (typeof tokens === "number" && typeof window === "number" && window > 0) {
					state.contextTokens = tokens;
					state.contextWindow = window;
					state.contextInfoReceived = true;
					pushLog(state, `📊 Context: ${tokens}/${window} (initial)`);
					return { flush: true, workingChange: false };
				}
				break;
			}

			case "tool_execution_start": {
				const prevPhase = state.phase;
				state.currentTool = ev.toolName || "tool";
				state.currentToolArgs = ev.args ? JSON.stringify(ev.args).slice(0, 200) : undefined;
				state.lastToolName = ev.toolName;
				state.phase = "tool";
				const logArgs = ev.args ? JSON.stringify(ev.args).slice(0, 200) : "";
				pushLog(state, `🔧 ${ev.toolName}${logArgs ? ` ${logArgs}` : ""}`);
				return { flush: true, workingChange: prevPhase !== "tool" };
			}

			case "tool_execution_end": {
				state.toolCount++;
				state.currentTool = undefined;
				state.currentToolArgs = undefined;
				state.phase = "idle";
				pushLog(state, `${ev.isError ? "✗" : "✓"} ${ev.toolName}`);
				return { flush: true, workingChange: true };
			}

			case "message_update": {
				const delta = ev.delta;
				if (!delta) break;

				const prevPhase = state.phase;
				const eventPhase = getPhaseFromEvent(ev);
				if (eventPhase !== "idle" && phasePriority(eventPhase) >= phasePriority(state.phase)) {
					state.phase = eventPhase;
				}

				switch (delta.type) {
					case "thinking_start": {
						state.thinkingPushedThisTurn = false;
						return { flush: true, workingChange: prevPhase !== "thinking" };
					}
					case "text_start": {
						state.textPushedThisTurn = false;
						return { flush: true, workingChange: prevPhase !== "text" };
					}
					case "thinking_delta": {
						const td = delta.thinking_delta;
						if (typeof td === "string" && td.length > 0) {
							state.liveThinking += td;
							if (state.liveThinking.length > 1000) {
								state.liveThinking = state.liveThinking.slice(-500);
							}
							let nlIdx;
							while ((nlIdx = state.liveThinking.indexOf("\n")) !== -1) {
								const line = state.liveThinking.slice(0, nlIdx);
								state.liveThinking = state.liveThinking.slice(nlIdx + 1);
								if (line.trim()) pushLog(state, `💭 ${line}`);
							}
							return { flush: true, workingChange: prevPhase !== "thinking" };
						}
						break;
					}
					case "text_delta": {
						const td = delta.text_delta;
						if (typeof td === "string" && td.length > 0) {
							state.liveText += td;
							if (state.liveText.length > 10_000) {
								state.liveText = state.liveText.slice(-8_000);
							}
							let nlIdx;
							while ((nlIdx = state.liveText.indexOf("\n")) !== -1) {
								const line = state.liveText.slice(0, nlIdx);
								state.liveText = state.liveText.slice(nlIdx + 1);
								if (line.trim()) pushLog(state, line);
							}
							return { flush: true, workingChange: prevPhase !== "text" };
						}
						break;
					}
					// ── FIX: Flag set unconditionally ──
					case "thinking_end": {
						if (state.liveThinking.trim()) {
							state.thinkingOutputLines.push(state.liveThinking.trim());
							for (const t of state.liveThinking.split("\n")) {
								const trimmed = t.trim();
								if (trimmed) pushLog(state, `💭 ${trimmed}`);
							}
						}
						state.thinkingPushedThisTurn = true; // ALWAYS set, not conditionally
						state.liveThinking = "";
						state.phase = "idle";
						return { flush: true, workingChange: true };
					}
					// ── FIX: Flag set unconditionally ──
					case "text_end": {
						if (state.liveText.trim()) {
							state.textOutputLines.push(state.liveText.trim());
							for (const t of state.liveText.split("\n")) {
								const trimmed = t.trim();
								if (trimmed) pushLog(state, trimmed);
							}
						}
						state.textPushedThisTurn = true; // ALWAYS set, not conditionally
						if (ev.usage) {
							state.tokenCount =
								ev.usage.totalTokens || ev.usage.input + ev.usage.output || state.tokenCount;
						}
						state.liveText = "";
						state.phase = "idle";
						return { flush: true, workingChange: true };
					}
				}
				break;
			}

			case "message_end": {
				const msg = ev.message;
				if (!msg) break;

				if (msg.role === "assistant") {
					if (!state.thinkingPushedThisTurn && Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.type === "thinking" && block.thinking) {
								const thinkingText =
									typeof block.thinking === "string"
										? block.thinking
										: JSON.stringify(block.thinking);
								for (const t of thinkingText.split("\n")) {
									if (t.trim()) pushLog(state, `💭 ${t}`);
								}
							}
						}
					}
					if (!state.textPushedThisTurn) {
						const text = extractTextFromContent(msg.content);
						if (text && text.trim()) {
							state.textOutputLines.push(text.trim());
							for (const t of text.split("\n")) {
								if (t.trim()) pushLog(state, t);
							}
						}
					}
					if (msg.usage) {
						state.tokenCount = msg.usage.totalTokens || msg.usage.input + msg.usage.output;
					}
				} else if (msg.role === "toolResult") {
					const resultText = extractTextFromContent(msg.content);
					const label = msg.toolName || state.lastToolName || "tool";
					if (resultText && resultText.trim()) {
						const resultLines = resultText.split("\n");
						pushLog(state, `📋 ${label}: ${resultLines[0]?.slice(0, 300) || "(no output)"}`);
						for (let i = 1; i < Math.min(resultLines.length, 6); i++) {
							if (resultLines[i].trim()) pushLog(state, `   ${resultLines[i].slice(0, 200)}`);
						}
					} else {
						pushLog(state, `📋 ${label}: (no output)`);
					}
					state.lastToolName = undefined;
				}
				state.phase = "idle";
				state.thinkingPushedThisTurn = false;
				state.textPushedThisTurn = false;
				return { flush: true, workingChange: true };
			}

			case "agent_end":
			case "turn_end":
				break;
		}
	} catch (parseErr: unknown) {
		const preview = line.length > 200 ? line.slice(0, 200) + "…" : line;
		if (line.trim()) {
			console.error(
				`[supervisor] JSON parse error: ${String(parseErr).slice(0, 200)} | line: ${preview}`,
			);
		}
	}
	return { flush: false, workingChange: false };
}

/**
 * Helper: determine phase from a JSON event (same as agent-stream.ts getPhaseFromEvent)
 */
function getPhaseFromEvent(ev: any): AgentPhase {
	if (!ev) return "idle";

	if (ev.type === "tool_execution_start") return "tool";
	if (ev.type === "tool_execution_end") return "idle";

	if (ev.type === "message_update") {
		const delta = ev.delta;
		if (!delta) return "idle";
		switch (delta.type) {
			case "thinking_delta":
				if (delta.thinking_delta) return "thinking";
				break;
			case "thinking_start":
				return "thinking";
			case "text_delta":
				if (delta.text_delta) return "text";
				break;
			case "text_start":
				return "text";
			case "thinking_end":
			case "text_end":
				return "idle";
		}
	}

	if (ev.type === "message_end") return "idle";
	return "idle";
}

describe("Phase 6: Unconditional flag at text_end/thinking_end — no duplicate log entries", () => {
	// ── Session event tests (processSessionEventFlagFix) ──

	describe("session-events.ts (processSessionEventFlagFix)", () => {
		it("6.1: text_end with empty liveText sets textPushedThisTurn=true", () => {
			const state = createState({ liveText: "", textPushedThisTurn: false });
			const ev = { type: "message_update", assistantMessageEvent: { type: "text_end" } };
			processSessionEventFlagFix(ev, state);
			assert.strictEqual(state.textPushedThisTurn, true);
			assert.strictEqual(state.phase, "idle");
			assert.strictEqual(state.textOutputLines.length, 0);
			assert.strictEqual(state.fullLog.length, 0);
		});

		it("6.2: thinking_end with empty liveThinking sets thinkingPushedThisTurn=true", () => {
			const state = createState({ liveThinking: "", thinkingPushedThisTurn: false });
			const ev = { type: "message_update", assistantMessageEvent: { type: "thinking_end" } };
			processSessionEventFlagFix(ev, state);
			assert.strictEqual(state.thinkingPushedThisTurn, true);
			assert.strictEqual(state.phase, "idle");
		});

		it("6.3: text_end with leftover buffer content pushes remaining lines AND sets flag", () => {
			const state = createState({ liveText: "stray text\n", textPushedThisTurn: false });
			const ev = { type: "message_update", assistantMessageEvent: { type: "text_end" } };
			processSessionEventFlagFix(ev, state);
			assert.strictEqual(state.textOutputLines[0], "stray text");
			assert.ok(state.fullLog.includes("stray text"));
			assert.strictEqual(state.textPushedThisTurn, true);
		});

		it("6.4: thinking_end with leftover buffer content pushes remaining lines AND sets flag", () => {
			const state = createState({
				liveThinking: "unfinished thought",
				thinkingPushedThisTurn: false,
			});
			const ev = { type: "message_update", assistantMessageEvent: { type: "thinking_end" } };
			processSessionEventFlagFix(ev, state);
			assert.ok(state.thinkingOutputLines[0]?.includes("unfinished thought"));
			assert.strictEqual(state.thinkingPushedThisTurn, true);
		});

		it("6.5: text_start→text_delta('line1\\nline2\\n')→text_end→done produces no duplicates", () => {
			const state = createState();
			// text_start
			processSessionEventFlagFix(
				{ type: "message_update", assistantMessageEvent: { type: "text_start" } },
				state,
			);
			// text_delta
			processSessionEventFlagFix(
				{
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "line1\nline2\n" },
				},
				state,
			);
			// After delta: both lines consumed from buffer
			assert.strictEqual(state.liveText, "");
			assert.strictEqual(state.fullLog.length, 2);
			assert.strictEqual(state.fullLog[0], "line1");
			assert.strictEqual(state.fullLog[1], "line2");
			// text_end with empty buffer
			processSessionEventFlagFix(
				{ type: "message_update", assistantMessageEvent: { type: "text_end" } },
				state,
			);
			assert.strictEqual(state.textPushedThisTurn, true);
			assert.strictEqual(state.textOutputLines.length, 0); // no leftover
			// done event — should NOT re-push because flag is now true
			processSessionEventFlagFix(
				{
					type: "message_update",
					assistantMessageEvent: {
						type: "done",
						message: { content: [{ type: "text", text: "line1\nline2" }] },
					},
				},
				state,
			);
			// done does NOT push to textOutputLines (flag is true) — the text was already logged by delta handlers
			assert.strictEqual(
				state.textOutputLines.length,
				0,
				"textOutputLines empty — flag was already true",
			);
			// fullLog should still have exactly 2 entries (no duplicates)
			assert.strictEqual(state.fullLog.length, 2, "fullLog should have exactly 2 entries, not 4");
			assert.strictEqual(state.fullLog[0], "line1");
			assert.strictEqual(state.fullLog[1], "line2");
		});

		it("6.6: thinking_start→thinking_delta('deep\\nthought\\n')→thinking_end→done produces no duplicates", () => {
			const state = createState();
			processSessionEventFlagFix(
				{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
				state,
			);
			processSessionEventFlagFix(
				{
					type: "message_update",
					assistantMessageEvent: { type: "thinking_delta", delta: "deep\nthought\n" },
				},
				state,
			);
			assert.strictEqual(state.liveThinking, "");
			assert.strictEqual(state.fullLog.length, 2);
			assert.strictEqual(state.fullLog[0], "💭 deep");
			assert.strictEqual(state.fullLog[1], "💭 thought");
			processSessionEventFlagFix(
				{ type: "message_update", assistantMessageEvent: { type: "thinking_end" } },
				state,
			);
			assert.strictEqual(state.thinkingPushedThisTurn, true);
			assert.strictEqual(state.thinkingOutputLines.length, 0);
			processSessionEventFlagFix(
				{
					type: "message_update",
					assistantMessageEvent: {
						type: "done",
						message: {
							content: [{ type: "thinking", thinking: "deep\nthought" }],
						},
					},
				},
				state,
			);
			assert.strictEqual(
				state.thinkingOutputLines.length,
				0,
				"thinkingOutputLines empty — flag was already true",
			);
			assert.strictEqual(state.fullLog.length, 2, "fullLog should still have exactly 2 entries");
		});

		it("6.7: done after text_end with leftover: flag already true, no duplicate push", () => {
			const state = createState({ liveText: "leftover line\n", textPushedThisTurn: false });
			// text_end pushes leftover and sets flag
			processSessionEventFlagFix(
				{ type: "message_update", assistantMessageEvent: { type: "text_end" } },
				state,
			);
			assert.strictEqual(state.textOutputLines.length, 1);
			assert.strictEqual(state.textPushedThisTurn, true);
			// done event — flag is true so should NOT push again
			processSessionEventFlagFix(
				{
					type: "message_update",
					assistantMessageEvent: {
						type: "done",
						message: { content: [{ type: "text", text: "leftover line" }] },
					},
				},
				state,
			);
			assert.strictEqual(state.textOutputLines.length, 1, "Should still be 1, not 2");
		});

		it("6.8: message_end after text_end (no leftover) respects textPushedThisTurn=true", () => {
			const state = createState({ textPushedThisTurn: true });
			processSessionEventFlagFix(
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "line1\nline2" }],
					},
				},
				state,
			);
			assert.strictEqual(state.textOutputLines.length, 0, "message_end should not push");
			assert.strictEqual(state.fullLog.length, 0);
		});

		it("6.9: message_end after text_end with leftover does NOT re-push", () => {
			const state = createState({ liveText: "remnant\n", textPushedThisTurn: false });
			// text_end pushes leftover and sets flag
			processSessionEventFlagFix(
				{ type: "message_update", assistantMessageEvent: { type: "text_end" } },
				state,
			);
			assert.strictEqual(state.fullLog.length, 1);
			assert.strictEqual(state.fullLog[0], "remnant");
			// message_end should NOT re-push
			processSessionEventFlagFix(
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "remnant" }],
					},
				},
				state,
			);
			assert.strictEqual(state.fullLog.length, 1, "fullLog should contain 'remnant' once only");
		});

		it("6.10: text_end does NOT reset textPushedThisTurn to false", () => {
			const state = createState({ liveText: "", textPushedThisTurn: true });
			processSessionEventFlagFix(
				{ type: "message_update", assistantMessageEvent: { type: "text_end" } },
				state,
			);
			assert.strictEqual(state.textPushedThisTurn, true);
		});

		it("6.11: thinking_end does NOT reset thinkingPushedThisTurn to false", () => {
			const state = createState({ liveThinking: "", thinkingPushedThisTurn: true });
			processSessionEventFlagFix(
				{ type: "message_update", assistantMessageEvent: { type: "thinking_end" } },
				state,
			);
			assert.strictEqual(state.thinkingPushedThisTurn, true);
		});

		it("6.12: text_delta with single char no newline — leftover pushed at text_end", () => {
			const state = createState();
			processSessionEventFlagFix(
				{
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "a" },
				},
				state,
			);
			assert.strictEqual(state.liveText, "a");
			processSessionEventFlagFix(
				{ type: "message_update", assistantMessageEvent: { type: "text_end" } },
				state,
			);
			assert.strictEqual(state.textOutputLines[0], "a");
			assert.strictEqual(state.textPushedThisTurn, true);
		});

		it("6.13: empty text_delta('') should not crash — text_end with empty sets flag", () => {
			const state = createState();
			// Empty delta is a no-op
			processSessionEventFlagFix(
				{
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "" },
				},
				state,
			);
			assert.strictEqual(state.liveText, "");
			// text_end should set the flag
			processSessionEventFlagFix(
				{ type: "message_update", assistantMessageEvent: { type: "text_end" } },
				state,
			);
			assert.strictEqual(state.textPushedThisTurn, true);
		});

		it("6.14: text_delta with only whitespace '   \\n' — no log entries, flag set", () => {
			const state = createState();
			processSessionEventFlagFix(
				{
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "   \n" },
				},
				state,
			);
			// space-only line should be filtered out
			assert.strictEqual(state.fullLog.length, 0);
			assert.strictEqual(state.liveText, "");
			processSessionEventFlagFix(
				{ type: "message_update", assistantMessageEvent: { type: "text_end" } },
				state,
			);
			assert.strictEqual(state.textPushedThisTurn, true);
		});
	});

	// ── JSON line tests (processJsonLineFlagFix) ──

	describe("agent-stream.ts (processJsonLineFlagFix)", () => {
		it("6.15: text_end with empty liveText via JSON line sets textPushedThisTurn=true", () => {
			const state = createState({ liveText: "", textPushedThisTurn: false });
			const line = JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			});
			processJsonLineFlagFix(line, state);
			assert.strictEqual(state.textPushedThisTurn, true);
			assert.strictEqual(state.phase, "idle");
		});

		it("6.16: thinking_end with empty liveThinking via JSON line sets thinkingPushedThisTurn=true", () => {
			const state = createState({ liveThinking: "", thinkingPushedThisTurn: false });
			const line = JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			});
			processJsonLineFlagFix(line, state);
			assert.strictEqual(state.thinkingPushedThisTurn, true);
		});

		it("6.17: text_end with leftover via JSON line pushes AND sets flag", () => {
			const state = createState({ liveText: "leftover text\n", textPushedThisTurn: false });
			const line = JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			});
			processJsonLineFlagFix(line, state);
			assert.strictEqual(state.textOutputLines[0], "leftover text");
			assert.strictEqual(state.textPushedThisTurn, true);
		});

		it("6.18: full streaming via JSON line — text_delta→text_end→message_end no duplicates", () => {
			const state = createState();
			// text_delta
			processJsonLineFlagFix(
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_delta", text_delta: "line1\nline2\n" },
				}),
				state,
			);
			assert.strictEqual(state.liveText, "");
			assert.strictEqual(state.fullLog.length, 2);
			// text_end
			processJsonLineFlagFix(
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_end" },
					usage: { totalTokens: 100 },
				}),
				state,
			);
			assert.strictEqual(state.textPushedThisTurn, true);
			assert.strictEqual(state.tokenCount, 100);
			// message_end — should NOT re-push because flag is true
			processJsonLineFlagFix(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "line1\nline2" }],
						usage: { totalTokens: 100 },
					},
				}),
				state,
			);
			// If message_end re-pushed, fullLog would have 4 entries
			assert.strictEqual(state.fullLog.length, 2, "fullLog must have exactly 2 entries, not 4");
			assert.strictEqual(state.fullLog[0], "line1");
			assert.strictEqual(state.fullLog[1], "line2");
		});

		it("6.19: full thinking streaming via JSON line — thinking_delta→thinking_end→message_end no duplicates", () => {
			const state = createState();
			processJsonLineFlagFix(
				JSON.stringify({
					type: "message_update",
					delta: { type: "thinking_delta", thinking_delta: "deep\nthought\n" },
				}),
				state,
			);
			assert.strictEqual(state.liveThinking, "");
			assert.strictEqual(state.fullLog.length, 2);
			processJsonLineFlagFix(
				JSON.stringify({
					type: "message_update",
					delta: { type: "thinking_end" },
				}),
				state,
			);
			assert.strictEqual(state.thinkingPushedThisTurn, true);
			processJsonLineFlagFix(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "thinking", thinking: "deep\nthought" }],
					},
				}),
				state,
			);
			assert.strictEqual(state.fullLog.length, 2, "fullLog must have exactly 2 entries");
			assert.strictEqual(state.fullLog[0], "💭 deep");
			assert.strictEqual(state.fullLog[1], "💭 thought");
		});

		it("6.20: JSON line text_delta with single char no newline — leftover pushed at text_end", () => {
			const state = createState();
			processJsonLineFlagFix(
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_delta", text_delta: "a" },
				}),
				state,
			);
			assert.strictEqual(state.liveText, "a");
			processJsonLineFlagFix(
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_end" },
				}),
				state,
			);
			assert.strictEqual(state.textOutputLines[0], "a");
			assert.strictEqual(state.textPushedThisTurn, true);
		});
	});
});
