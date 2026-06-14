/**
 * session-test-helpers.ts — Shared entry factories for waste-signal tests
 *
 * Consumed by all per-detector test files. Provides entry constructors
 * and session builder so individual tests don't repeat boilerplate.
 *
 * NOTE: The makeSession() function returns SessionData with the same
 * entry array references — D5 (error-loop) uses data.entries.indexOf(err)
 * which requires reference identity.
 */

import type { SessionData, SessionEntry } from "../types.ts";

export function makeSession(entries: SessionEntry[]): SessionData {
	return { sessionId: "test-session", timestamp: "", entries };
}

// ── Entry constructors ──

export function readEntry(path: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "read", args: { path }, text: path, turnIndex };
}

export function bashEntry(cmd: string, turnIndex: number, isError?: boolean): SessionEntry {
	return {
		type: isError ? "tool_result" : "tool_use",
		toolName: "bash",
		args: { command: cmd },
		text: cmd,
		turnIndex,
		isError,
	};
}

export function writeEntry(path: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "write", args: { path }, text: path, turnIndex };
}

export function editEntry(path: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "edit", args: { path }, text: path, turnIndex };
}

export function structuralSearchEntry(turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "structural_search", args: {}, text: "", turnIndex };
}

// Phase 2 discovery tool helpers
export function ripgrepSearchEntry(turnIndex: number): SessionEntry {
	return {
		type: "tool_use",
		toolName: "ripgrep_search",
		args: { query: "test" },
		text: "",
		turnIndex,
	};
}

export function webSearchEntry(turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "web_search", args: { query: "test" }, text: "", turnIndex };
}

export function webCrawlEntry(turnIndex: number): SessionEntry {
	return {
		type: "tool_use",
		toolName: "web_crawl",
		args: { url: "https://example.com" },
		text: "",
		turnIndex,
	};
}

export function askUserEntry(turnIndex: number): SessionEntry {
	return {
		type: "tool_use",
		toolName: "ask_user",
		args: { question: "test" },
		text: "",
		turnIndex,
	};
}

/** Non-discovery bash (build/test commands, not search/read). */
export function nonDiscoveryBashEntry(cmd: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "bash", args: { command: cmd }, text: cmd, turnIndex };
}

export function readToolError(turnIndex: number): SessionEntry {
	return {
		type: "tool_result",
		toolName: "read",
		isError: true,
		args: {},
		text: "ENOENT: no such file",
		turnIndex,
	};
}

export function toolCallPair(
	toolName: string,
	turnIndex: number,
	args: Record<string, unknown> = {},
	isError: boolean = false,
): [SessionEntry, SessionEntry] {
	return [
		{ type: "tool_use", toolName, args, text: "", turnIndex },
		{ type: "tool_result", toolName, isError, args: {}, text: "ok", turnIndex },
	];
}

// ── Identical-args helpers ──

export function identicalBashEntry(cmd: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "bash", args: { command: cmd }, text: cmd, turnIndex };
}

export function identicalStructuralSearchEntry(turnIndex: number): SessionEntry {
	return {
		type: "tool_use",
		toolName: "structural_search",
		args: { pattern: "test" },
		text: "",
		turnIndex,
	};
}

// ── D7 helpers ──

/**
 * Generate N tool_use entries (without tool_result pairs) for a single turn.
 * Used to reach the >=15 tool call threshold without doubling entries.
 */
export function nReadEntries(n: number, path: string, turnIndex: number): SessionEntry[] {
	const result: SessionEntry[] = [];
	for (let i = 0; i < n; i++) {
		result.push(readEntry(path, turnIndex));
	}
	return result;
}

/**
 * Build a scenario: some reads in turn 0, then 15 purely-repeat calls in target turn.
 * Returns entries where target turn has 15 tool_use calls, all on the given path,
 * with zero file-change tools and zero discovery tools.
 */
export function buildNoDiscoveryTurn(
	priorReads: string[],
	targetTurn: number,
	repeatPath: string,
): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const p of priorReads) {
		entries.push(readEntry(p, 0));
	}
	// 15 read calls on repeatPath in targetTurn — no novel files, no discovery tools
	for (let i = 0; i < 15; i++) {
		entries.push(readEntry(repeatPath, targetTurn));
	}
	return entries;
}
