/**
 * adapter-split.test.mts — barrel contract + size guards for the adapter/ split
 * (Clean Code Audit #1405, issue #1411).
 *
 * Guards the behavior-preserving file split:
 *  - event/adapter.ts remains a 1-line shim re-exporting adapter/index.ts
 *  - all 7 runtime symbols + 4 types still resolve through the shim
 *  - per-module nbnc (non-blank/non-comment) line budget ≤ 500 (SonarQube S104)
 *  - per-module function span ≤ 100, handleContextInfo ≤ 45 (S138)
 *  - forward characterization: forwardNormalizedEventToChat/createForwardChatState
 *    (previously untested directly)
 *  - module-graph integrity: normalize → handlers dispatch edge and forward module
 *    load standalone with no TDZ/cycle failure
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunState } from "../config/types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	normalizeEvent,
	agentSessionEventToNormalizedEvent,
	jsonLineToNormalizedEvent,
	filterStderr,
	processNormalizedEvent,
	forwardNormalizedEventToChat,
	createForwardChatState,
} from "../event/adapter.ts";
import type {
	NormalizedEvent,
	NormalizedUsage,
	HandlerResult,
	ForwardChatState,
} from "../event/adapter.ts";
// Direct module imports — prove each module is standalone-importable (acyclic graph)
import { processNormalizedEvent as processNormalizedEventDirect } from "../event/adapter/normalize.ts";
import { handleContextInfo } from "../event/adapter/handlers.ts";
import { forwardNormalizedEventToChat as forwardNormalizedEventToChatDirect } from "../event/adapter/forward.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADAPTER_DIR = join(__dirname, "../event/adapter");
const SHIM_FILE = join(__dirname, "../event/adapter.ts");

const MODULES = ["normalize.ts", "handlers.ts", "forward.ts", "index.ts"];

const RUNTIME_EXPORTS: Array<{ name: string; value: unknown }> = [
	{ name: "normalizeEvent", value: normalizeEvent },
	{ name: "agentSessionEventToNormalizedEvent", value: agentSessionEventToNormalizedEvent },
	{ name: "jsonLineToNormalizedEvent", value: jsonLineToNormalizedEvent },
	{ name: "filterStderr", value: filterStderr },
	{ name: "processNormalizedEvent", value: processNormalizedEvent },
	{ name: "forwardNormalizedEventToChat", value: forwardNormalizedEventToChat },
	{ name: "createForwardChatState", value: createForwardChatState },
];

/** Non-blank/non-comment line count — mirrors the issue's awk-style measure. */
function nbnc(source: string): number {
	return source.split("\n").filter((line) => {
		const t = line.trim();
		if (t === "") return false;
		if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return false;
		return true;
	}).length;
}

/** Line span of a function by name in a single module source. */
function functionSpan(source: string, fnName: string): number | null {
	const lines = source.split("\n");
	const startIdx = lines.findIndex((l) => new RegExp(`function\\s+${fnName}\\s*\\(`).test(l));
	if (startIdx === -1) return null;
	let depth = 0;
	for (let i = startIdx; i < lines.length; i++) {
		for (const ch of lines[i]!) {
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) return i - startIdx + 1;
			}
		}
	}
	return null;
}

/** Max brace-balanced span of any function (named or const-arrow) in a module. */
function maxFunctionSpan(source: string): number {
	const lines = source.split("\n");
	let maxSpan = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const isFnStart =
			/function\s+[\w]*\s*\(/.test(line) ||
			/^\s*(?:export\s+)?const\s+[\w]+\s*=\s*\([^)]*\)\s*=>/.test(line);
		if (!isFnStart) continue;
		let depth = 0;
		let started = false;
		for (let j = i; j < lines.length; j++) {
			for (const ch of lines[j]!) {
				if (ch === "{") {
					depth++;
					started = true;
				} else if (ch === "}") depth--;
			}
			if (started && depth === 0) {
				maxSpan = Math.max(maxSpan, j - i + 1);
				break;
			}
		}
	}
	return maxSpan;
}

// ─── Helpers ──────────────────────────────────────────────────────

function createState(overrides?: Partial<AgentRunState>): AgentRunState {
	return {
		currentTool: undefined,
		currentToolArgs: undefined,
		toolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		lastToolName: undefined,
		phase: "idle",
		startedAt: Date.now(),
		contextTokens: undefined,
		contextWindow: undefined,
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		toolCalls: [],
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: 0,
		agentTokenBudget: 0,
		...overrides,
	};
}

function createPi(): { sent: Array<Record<string, any>>; pi: Pick<ExtensionAPI, "sendMessage"> } {
	const sent: Array<Record<string, any>> = [];
	const pi = {
		sendMessage: ((msg: any) => {
			sent.push(msg);
		}) as ExtensionAPI["sendMessage"],
	};
	return { sent, pi };
}

// ---------------------------------------------------------------------------
// Phase 1: Split mechanics — structure guards + export surface
// ---------------------------------------------------------------------------

describe("adapter/ split — shim + export surface", () => {
	it("event/adapter.ts remains a file: 1-line re-export shim", () => {
		assert.ok(existsSync(SHIM_FILE), "event/adapter.ts exists (shim, not directory)");
		const shim = readFileSync(SHIM_FILE, "utf-8").trim();
		assert.equal(shim, 'export * from "./adapter/index.ts";');
	});

	it("exports all 7 runtime symbols from the shim", () => {
		for (const { name, value } of RUNTIME_EXPORTS) {
			assert.equal(
				typeof value,
				"function",
				`event/adapter.ts export "${name}" is ${typeof value} (dropped export?)`,
			);
		}
	});

	it("re-exports the 4 public types through the shim", () => {
		const ev: NormalizedEvent = { kind: "session" };
		const usage: NormalizedUsage = { totalTokens: 1 };
		const hr: HandlerResult = { flush: true, workingChange: false };
		const fwd: ForwardChatState = createForwardChatState();
		assert.equal(ev.kind, "session");
		assert.equal(usage.totalTokens, 1);
		assert.equal(hr.flush, true);
		assert.equal(fwd.toolSeqNum, 0);
	});

	it("index.ts uses star re-exports only (no TS1205-fragile named type re-export)", () => {
		const src = readFileSync(join(ADAPTER_DIR, "index.ts"), "utf-8");
		assert.ok(!src.includes("export {"), "index.ts must not use named re-exports");
	});
});

// ---------------------------------------------------------------------------
// Phase 1: Size guards (S104 file budget, S138 function budget)
// ---------------------------------------------------------------------------

describe("adapter/ split — size guards", () => {
	it("each adapter/*.ts module stays ≤ 500 nbnc lines", () => {
		for (const f of MODULES) {
			const src = readFileSync(join(ADAPTER_DIR, f), "utf-8");
			const count = nbnc(src);
			assert.ok(count <= 500, `${f} has ${count} nbnc lines — over the S104 ceiling of 500`);
		}
	});

	it("max function span ≤ 100 lines in each module", () => {
		for (const f of MODULES) {
			const src = readFileSync(join(ADAPTER_DIR, f), "utf-8");
			const span = maxFunctionSpan(src);
			assert.ok(
				span <= 100,
				`${f} has a function spanning ${span} lines — over S138 ceiling of 100`,
			);
		}
	});

	it("handleContextInfo span ≤ 45 lines in handlers.ts", () => {
		const src = readFileSync(join(ADAPTER_DIR, "handlers.ts"), "utf-8");
		const span = functionSpan(src, "handleContextInfo");
		assert.ok(span !== null, "handleContextInfo found in handlers.ts");
		assert.ok(span <= 45, `handleContextInfo spans ${span} lines — block artifact not relocated`);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: Forward characterization (previously untested directly)
// ---------------------------------------------------------------------------

describe("forwardNormalizedEventToChat — chat rendering", () => {
	it("createForwardChatState returns the documented initial shape", () => {
		assert.deepEqual(createForwardChatState(), {
			toolSeqNum: 0,
			pendingToolName: "",
			pendingToolFormattedArgs: "",
			pendingToolStartTime: 0,
			pendingToolIsError: false,
		});
	});

	it("tool_execution_start → one sendMessage (tool-start), pending updated", () => {
		const state = createState();
		const pending = createForwardChatState();
		const { sent, pi } = createPi();
		forwardNormalizedEventToChat(
			{ kind: "tool_execution_start", toolName: "read", args: { path: "/x" } },
			state,
			pi,
			"test-agent",
			pending,
		);
		assert.equal(sent.length, 1);
		const msg = sent[0]!;
		assert.equal(msg.customType, "supervisor");
		assert.ok(msg.content.startsWith("⏳ test-agent — "), `content: ${msg.content}`);
		assert.equal(msg.details.eventType, "tool-start");
		assert.equal(msg.details.toolName, "read");
		assert.equal(pending.toolSeqNum, 1);
		assert.equal(pending.pendingToolName, "read");
		assert.ok(pending.pendingToolStartTime > 0);
		assert.equal(pending.pendingToolIsError, false);
	});

	it("tool_execution_end with isError → pending flagged, no sendMessage", () => {
		const state = createState();
		const pending = { ...createForwardChatState(), toolSeqNum: 1, pendingToolName: "read" };
		const { sent, pi } = createPi();
		forwardNormalizedEventToChat(
			{ kind: "tool_execution_end", toolName: "read", isError: true },
			state,
			pi,
			"test-agent",
			pending,
		);
		assert.equal(pending.pendingToolIsError, true);
		assert.equal(sent.length, 0);
	});

	it("message_end role toolResult → one sendMessage (tool-complete), pending reset", () => {
		const state = createState({
			tokenCount: 42,
			toolCount: 3,
			failedToolCount: 1,
			maxToolCalls: 5,
			agentTokenBudget: 1000,
		});
		const pending = {
			...createForwardChatState(),
			toolSeqNum: 1,
			pendingToolName: "read",
			pendingToolFormattedArgs: "read /x",
			pendingToolStartTime: Date.now(),
			pendingToolIsError: false,
		};
		const { sent, pi } = createPi();
		forwardNormalizedEventToChat(
			{
				kind: "message_end",
				message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "ok" }] },
			},
			state,
			pi,
			"test-agent",
			pending,
		);
		assert.equal(sent.length, 1);
		const msg = sent[0]!;
		assert.equal(msg.customType, "supervisor");
		assert.equal(msg.details.eventType, "tool-complete");
		assert.equal(msg.details.toolName, "read");
		assert.equal(msg.details.args, "read /x");
		assert.equal(msg.details.isError, false);
		assert.equal(msg.details.toolIndex, "#1");
		assert.equal(msg.details.runningTokenCount, 42);
		assert.equal(msg.details.runningToolCount, 3);
		assert.equal(msg.details.errorCount, 1);
		assert.equal(msg.details.maxToolCalls, 5);
		assert.equal(msg.details.agentTokenBudget, 1000);
		// pending reset after completion
		assert.equal(pending.pendingToolName, "");
		assert.equal(pending.pendingToolFormattedArgs, "");
		assert.equal(pending.pendingToolStartTime, 0);
		assert.equal(pending.pendingToolIsError, false);
	});

	it("message_end role assistant → no sendMessage", () => {
		const state = createState();
		const pending = createForwardChatState();
		const { sent, pi } = createPi();
		forwardNormalizedEventToChat(
			{
				kind: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			},
			state,
			pi,
			"test-agent",
			pending,
		);
		assert.equal(sent.length, 0);
	});

	it("thinking_end with preThinkingText → one sendMessage (thinking)", () => {
		const state = createState();
		const pending = createForwardChatState();
		const { sent, pi } = createPi();
		forwardNormalizedEventToChat(
			{ kind: "thinking_end" },
			state,
			pi,
			"test-agent",
			pending,
			"reasoning about it",
		);
		assert.equal(sent.length, 1);
		const msg = sent[0]!;
		assert.equal(msg.details.eventType, "thinking");
		assert.equal(msg.content, "💭 test-agent");
		assert.equal(msg.details.content, "reasoning about it");
	});

	it("thinking_end without preThinkingText → no sendMessage", () => {
		const state = createState();
		const pending = createForwardChatState();
		const { sent, pi } = createPi();
		forwardNormalizedEventToChat({ kind: "thinking_end" }, state, pi, "test-agent", pending);
		assert.equal(sent.length, 0);
	});

	it("no-op kinds → no sendMessage, no throw", () => {
		const state = createState();
		const pending = createForwardChatState();
		const noOps: NormalizedEvent[] = [
			{ kind: "session" },
			{ kind: "agent_start" },
			{ kind: "turn_start" },
			{ kind: "text_start" },
			{ kind: "text_delta", delta: "" },
			{ kind: "text_end" },
			{ kind: "context_info", contextTokens: 1000, contextWindow: 2000 },
		];
		for (const ev of noOps) {
			const { sent, pi } = createPi();
			assert.doesNotThrow(() => forwardNormalizedEventToChat(ev, state, pi, "test-agent", pending));
			assert.equal(sent.length, 0, `no sendMessage for ${ev.kind}`);
		}
	});
});

// ---------------------------------------------------------------------------
// Phase 3: Module-graph integrity
// ---------------------------------------------------------------------------

describe("adapter/ split — module graph integrity", () => {
	it("normalize → handlers dispatch edge loads (context_info via direct module imports)", () => {
		const state = createState();
		const result = processNormalizedEventDirect(
			{ kind: "context_info", contextTokens: 1000, contextWindow: 2000 },
			state,
		);
		assert.deepEqual(result, { flush: true, workingChange: false });
		assert.equal(state.contextInfoReceived, true);
		assert.ok(state.fullLog.includes("📊 Context: 1.0K/2.0K (initial)"));
		// handleContextInfo itself resolves from handlers.ts (no cycle/TDZ at load)
		const direct = handleContextInfo(state, {
			kind: "context_info",
			contextTokens: 3000,
			contextWindow: 6000,
		});
		assert.deepEqual(direct, { flush: true, workingChange: false });
		assert.equal(state.contextTokens, 3000);
	});

	it("forward module is standalone-importable (no top-level side effects)", () => {
		const state = createState();
		const pending = createForwardChatState();
		const { sent, pi } = createPi();
		forwardNormalizedEventToChatDirect(
			{ kind: "tool_execution_start", toolName: "bash" },
			state,
			pi,
			"test-agent",
			pending,
		);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.details.eventType, "tool-start");
	});

	it("shim surface and direct module imports resolve to the same behavior", () => {
		const viaShim = processNormalizedEvent({ kind: "turn_start" }, createState());
		const viaModule = processNormalizedEventDirect({ kind: "turn_start" }, createState());
		assert.deepEqual(viaShim, viaModule);
	});
});
