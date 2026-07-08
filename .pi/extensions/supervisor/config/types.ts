// ─── Supervisor Types ─────────────────────────────────────────────
// All interfaces, types, enums. Zero logic, no functions.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// Re-export SupervisorConfig type derived from zod schema (single source of truth).
export type { SupervisorConfig } from "./config.ts";

export interface AgentFrontmatter {
	name: string;
	description?: string;
	tools?: string;
	model?: string;
	extensions?: string;
	thinking?: string;
	skills?: string;
	[key: string]: unknown;
}

export interface ParsedAgent {
	config: AgentFrontmatter;
	systemPrompt: string;
}

export interface ProjectField {
	id: string;
	name: string;
	type: string;
	options?: Array<{ id: string; name: string }>;
}

export interface ProjectItem {
	id: string;
	status?: string;
	content?: { url?: string; number?: number };
	fieldValues?: { fieldId: string; value: string; optionId?: string }[];
}

/** Filtered issue data after codeowner trust check */
export interface FilteredIssueData {
	/** Issue body (empty string if author not a trusted codeowner) */
	body: string;
	/** Only comments from trusted codeowners */
	comments: Array<{ author: string; body: string }>;
}

/** DebugLogger type — re-exported from debug.ts (canonical definition) */
export type { DebugLogger } from "../lib/debug.ts";

/** Common signature for agent runners (in-process and subprocess) */
export type AgentRunner = (
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number,
	cwd?: string,
	maxToolCalls?: number,
	agentTokenBudget?: number,
	sessionPath?: string,
	pi?: Pick<ExtensionAPI, "sendMessage">,
) => Promise<AgentRunResult>;

/** Structured result returned by runAgent for rendering */
export interface AgentRunResult {
	output: string;
	success: boolean;
	agentName: string;
	toolCount: number;
	tokenCount: number;
	durationMs: number;
	/** Number of tool executions that ended with an error */
	failedToolCount?: number;
	/** Clean text output from the agent (no tool/emoji noise) */
	textOutput: string;
	/** Brief summary line: what the agent accomplished */
	summaryLine: string;
	/** Raw stderr if any */
	errorOutput: string;
	/** Text-only output for marker detection (no tool/thinking noise) */
	textOnly: string;
	/** Thinking output from sub-agent (for expanded message renderer view) */
	thinkingOutput?: string;
	/** Whether budget (token/tool limit) was exceeded */
	budgetExceeded?: boolean;

	// ─── Per-agent usage breakdown ────────────────────────
	/** Model identifier used for this agent run */
	model?: string;
	/** Input tokens consumed (from last assistant message usage) */
	inputTokens?: number;
	/** Output tokens produced (from last assistant message usage) */
	outputTokens?: number;
	/** Prompt cache read tokens */
	cacheRead?: number;
	/** Prompt cache write tokens */
	cacheWrite?: number;
	/** Monetary cost of the agent run */
	cost?: number;
	/** Number of LLM turns (assistant messages with usage) */
	turnCount?: number;
	/** Thinking level used by the agent (e.g. "off", "low", "medium", "high") */
	thinkingLevel?: string;
}

// ─── AgentRunState: mutable state during agent execution ────────────

export type AgentPhase = "idle" | "thinking" | "tool" | "text";

export interface AgentRunState {
	currentTool?: string;
	currentToolArgs?: string;
	toolCount: number;
	tokenCount: number;
	fullLog: string[];
	liveThinking: string;
	liveText: string;
	textOutputLines: string[];
	thinkingOutputLines: string[];
	lastToolName?: string;
	phase: AgentPhase;
	startedAt: number;
	contextTokens?: number;
	contextWindow?: number;
	contextInfoReceived: boolean;
	/** Whether thinking was already pushed via streaming (dedup message_end) */
	thinkingPushedThisTurn: boolean;
	/** Whether text was already pushed via streaming (dedup message_end) */
	textPushedThisTurn: boolean;
	/** Whether budget (token/tool limit) was exceeded */
	budgetExceeded: boolean;
	/** Human-readable reason for budget exceeded */
	budgetExceededReason?: string;
	/** Max tool calls allowed (0 = unlimited, populated from config) */
	maxToolCalls: number;
	/** Number of tool executions that ended with an error */
	failedToolCount?: number;
	/** Max tokens allowed (0 = unlimited, populated from config) */
	agentTokenBudget: number;
	/** LLM prompt cache read tokens (from message usage) */
	cacheRead?: number;
	/** LLM prompt cache write tokens (from message usage) */
	cacheWrite?: number;
	/** Thinking level used by the agent (e.g. "off", "low", "medium", "high") */
	thinkingLevel?: string;
}

// ─── Message renderer details type ───────────────────────────────────

export interface SupervisorMessageDetails {
	agentName: string;
	success: boolean;
	statusLabel: string;
	toolCount: number;
	tokenCount: number;
	durationMs: number;
	/** Agent text output (optional — excluded from sendAgentResultMessage
	 *  to prevent subagent context leak into supervisor session, GH #525) */
	textOutput?: string;
	summaryLine: string;
	/** Thinking output for expanded view */
	thinkingOutput?: string;
	/** Whether thinking output is available */
	hasThinking?: boolean;
	/** Complete raw stdout+stderr from agent session (optional — excluded
	 *  from sendAgentResultMessage to prevent subagent context leak into
	 *  supervisor session, GH #525) */
	rawOutput?: string;
	/** Whether raw output is available */
	hasRawOutput?: boolean;
	/** Audit score extracted from auditor output, e.g. "5/6" */
	auditScore?: string;
	/** Task prompt given to the agent (displayed in expanded view) */
	taskPrompt?: string;

	// ─── Per-agent usage breakdown ────────────────────────
	/** Model identifier used for this agent run */
	model?: string;
	/** Input tokens consumed (from last assistant message usage) */
	inputTokens?: number;
	/** Output tokens produced (from last assistant message usage) */
	outputTokens?: number;
	/** Prompt cache read tokens */
	cacheRead?: number;
	/** Prompt cache write tokens */
	cacheWrite?: number;
	/** Monetary cost of the agent run */
	cost?: number;
	/** Number of LLM turns (assistant messages with usage) */
	turnCount?: number;
	/** Thinking level used by the agent (e.g. "off", "low", "medium", "high") */
	thinkingLevel?: string;
}

// ─── Dependency gate types ─────────────────────────────────────────

interface BlockerInfo {
	number: number;
	title: string;
	type: "issue" | "pullrequest";
	state: string;
}

export interface DepsResult {
	blocked: boolean;
	blockers: BlockerInfo[];
}

interface GhBlockingIssue {
	id: string;
	number: number;
	title: string;
	state: string;
}

interface GhTimelineNode {
	__typename: string;
	blockingIssue?: GhBlockingIssue | null;
}

export interface GhTimelineResponse {
	data?: {
		repository?: {
			issue?: {
				timelineItems?: {
					nodes?: GhTimelineNode[];
				};
			};
		};
	};
	errors?: Array<{ message: string }>;
}

// ─── PR Conflict types ──────────────────────────────────────────────

export interface PrConflictInfo {
	number: number;
	hasConflict: boolean;
	mergeable: string;
	mergeStateStatus: string;
	headRefName: string;
	baseRefName: string;
}

// ─── PR Creation Result ──────────────────────────────────────────────

/** Result of PR creation attempt — allows handler to react to failure */
export interface PrCreationResult {
	/** Whether the PR was created/updated successfully */
	success: boolean;
	/** PR number if created/updated successfully */
	prNumber?: number;
	/** Error message if creation failed */
	error?: string;
	/** Whether this was an update to an existing PR */
	wasUpdate?: boolean;
	/** Source identifier for error tracking (e.g. "pr-creation") */
	source?: string;
}

// ─── Merge result ────────────────────────────────────────────────────

/** Track per-agent outcome for final summary */
export interface PipelineAgentResult {
	agentName: string;
	status: "SUCCESS" | "SUCCESS (after retry)" | "FAILED";
	durationMs: number;
	tokenCount: number;
	toolCount: number;
	/** Model identifier from agent frontmatter, e.g. "anthropic/claude-sonnet-4-20250514" */
	model?: string;
	/** Number of tool executions that ended with an error */
	failedToolCount?: number;
	/** Error output from agent execution (stderr, crash diagnostics) */
	errorOutput?: string;
}

export interface MergeResult {
	success: boolean;
	conflictFiles: string[];
	message: string;
}

// ─── Agent Output Schema ────────────────────────────────────────────
// Single JSON schema for all agent outputs. No text markers, no regex.
// All agents output the same structure; pipeline parses it deterministically.

/** Supported action types — single vocabulary for all agents */
type AgentAction = "COMPLETE" | "APPROVED" | "REJECTED";

/** Severity levels for audit findings */
export type FindingSeverity = "critical" | "warning" | "suggestion";

/** Known audit dimensions */
type AuditDimension =
	| "architecture-compliance"
	| "ticket-fulfillment"
	| "tests-passed"
	| "test-quality"
	| "correctness-safety"
	| "code-quality"
	| "completeness"
	| string;

/** A single audit finding */
export interface Finding {
	severity: FindingSeverity;
	dimension: AuditDimension;
	symptom: string;
	consequence: string;
	remedy: string;
	location?: string;
}

/** Structured output that all agents must produce as their final message */
export interface AgentOutput {
	action: AgentAction;
	agentName: string;
	/** Brief summary line describing what the agent accomplished */
	summary?: string;
	/** Comment body to post on the GitHub issue */
	commentBody?: string;
	/** PR title (auditor only) */
	prTitle?: string;
	/** PR body (auditor only) */
	prBody?: string;
	/** Audit score (auditor only) */
	auditScore?: { passing: number; total: number };
	/** Audit findings (auditor only, for rejection) */
	findings?: Finding[];
	/**
	 * Target status for explicit pipeline transition override.
	 * When present and non-empty, bypasses all markerMap filtering,
	 * action branches, and text marker fallbacks.
	 * Agents use this to signal feedback loops (e.g., architect → Research)
	 * or to target any valid workflow status directly.
	 */
	targetStatus?: string;
	/** Refusal reason — if set, pipeline treats as rejection */
	refusal?: string;
}

/** Result of a failed parse attempt */
export interface FailedParse {
	error: string;
	rawOutput: string;
}

export type ParseResult = AgentOutput | FailedParse;

// ─── LSP Pre-Audit ──────────────────────────────────────────────────

interface LspPreAuditDecision {
	/** New status to transition to — "Audit" if proceeding, "Implementation" if blocking */
	nextStatus: string;
	/** Note to include in notification */
	note: string;
	/** Whether LSP audit was actually triggered */
	auditTriggered: boolean;
}
