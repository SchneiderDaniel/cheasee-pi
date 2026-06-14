/**
 * advisor.ts — Pure waste-signal detectors for session analysis
 *
 * Each detector reads parsed session entries and returns WasteSignal[]
 * with exact token waste (from JSONL usage field or char-length estimate).
 *
 * Zero pi dependencies — domain layer only.
 * No LLM calls. Pure functions.
 */

import { readFileSync } from "node:fs";
import { isBashSearch, isBashFileRead, isBashSearchOrRead } from "../lib/bash-query.ts";

// ── Types ──

export interface WasteSignal {
	signal: string;
	label: string;
	wastedTokens: number;
	wastedCost: number;
	occurrences: number;
	details: string[];
	context: {
		turnRange?: [number, number];
		files?: string[];
		toolName?: string;
	};
}

export interface SessionAnalysis {
	sessionId: string;
	timestamp: string;
	totalTokens: number;
	totalCost: number;
	totalWasteTokens: number;
	totalWasteCost: number;
	wasteFraction: number;
	wasteBySignal: WasteSignal[];
}

export interface SessionEntry {
	type: string;
	toolName?: string;
	isError?: boolean;
	args?: Record<string, unknown>;
	text?: string;
	turnIndex: number;
	/** Actual assistant token cost for the call that produced this entry (0 if toolResult) */
	assistantCost?: number;
	/** Assistant usage object from the message that produced this entry */
	usage?: { input: number; output: number; totalTokens: number; cost?: number };
	/** Tool result text length (chars) */
	outputSize?: number;
}

export interface SessionData {
	sessionId: string;
	timestamp: string;
	entries: SessionEntry[];
}

// ── JSONL parser ──

/**
 * Parse a .jsonl session file into SessionData with token cost data.
 * Extracts usage from assistant messages and output size from toolResults.
 */
export function parseJsonlFile(filepath: string): SessionData | null {
	const raw = readFileSync(filepath, "utf-8").trim();
	if (!raw) return null;

	const lines = raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	if (lines.length === 0) return null;

	const header = lines[0];
	const sessionId: string = header.id ?? "unknown";
	const timestamp: string = header.timestamp ?? "";

	const entries: SessionEntry[] = [];
	let turnIndex = -1;
	let pendingAssistantCost = 0;
	let pendingUsage: SessionEntry["usage"] = undefined;

	for (const rawEntry of lines) {
		const type = rawEntry.type;
		if (type === "session") continue;

		// Track assistant messages with usage before their tool calls
		if (type === "message" && rawEntry.message?.role === "assistant") {
			if (turnIndex < 0) turnIndex = 0;
			const usage = rawEntry.message?.usage;
			if (usage) {
				pendingAssistantCost = usage.totalTokens ?? 0;
				pendingUsage = {
					input: usage.input ?? 0,
					output: usage.output ?? 0,
					totalTokens: usage.totalTokens ?? 0,
					cost: usage.cost?.total ?? 0,
				};
			}

			const content = rawEntry.message?.content ?? [];
			for (const c of content) {
				if (c.type === "toolCall") {
					const args = c.arguments ?? {};
					const cmd = (args.command ?? "") as string;
					entries.push({
						type: "tool_use",
						toolName: c.name ?? "?",
						args,
						text: cmd,
						turnIndex,
						assistantCost: pendingAssistantCost || undefined,
						usage: pendingUsage,
					});
					// Reset so we don't double-count if multiple tool calls in one assistant msg
					pendingAssistantCost = 0;
					pendingUsage = undefined;
				}
			}
			continue;
		}

		// User message = new turn
		if (type === "message" && rawEntry.message?.role === "user") {
			turnIndex++;
			continue;
		}

		if (type === "message" && rawEntry.message?.role === "toolResult") {
			if (turnIndex < 0) turnIndex = 0;

			const content = rawEntry.message?.content ?? [];
			const textParts: string[] = [];
			for (const c of content) {
				if (c.type === "text") textParts.push(c.text ?? "");
			}
			const text = textParts.join("\n");
			const toolName = rawEntry.message?.toolName ?? "?";
			const isError = rawEntry.message?.isError ?? false;

			entries.push({
				type: "tool_result",
				toolName,
				isError,
				text,
				turnIndex,
				outputSize: text.length,
			});
		}
	}

	return { sessionId, timestamp, entries };
}

// ── Token estimation helpers ──

/** Rough tokens from text length (chars/4). */
function charsToTokens(s: string): number {
	return Math.ceil((s ?? "").length / 4);
}

/** Get total assist cost for a list of entries (sum of assistantCost or chars/4). */
function sumTokenCost(entries: SessionEntry[]): number {
	return entries.reduce((sum, e) => {
		if (e.assistantCost) return sum + e.assistantCost;
		if (e.text) return sum + charsToTokens(e.text);
		return sum + 100; // default overhead
	}, 0);
}

/** Get total dollar cost for a list of entries. */
function sumDollarCost(entries: SessionEntry[]): number {
	return entries.reduce((sum, e) => {
		if (e.usage?.cost) return sum + e.usage.cost;
		return sum;
	}, 0);
}

// ── Helpers ──

function shortPath(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx >= 0 ? p.slice(idx + 1) : p;
}

function getEntryPath(e: SessionEntry): string {
	return ((e.args?.path as string) ?? e.text ?? "") as string;
}

// ── Detectors ──

/**
 * D1: Redundant reads — same file path read within 2 turns.
 */
function detectRedundantReads(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const reads: Array<{ path: string; turnIndex: number; entry: SessionEntry }> = [];

	for (const e of data.entries) {
		if (e.toolName !== "read") continue;
		const p = getEntryPath(e);
		if (!p) continue;

		const redundant = reads.filter(
			(r) =>
				r.path === p && Math.abs(r.turnIndex - e.turnIndex) <= 2 && r.turnIndex !== e.turnIndex,
		);
		if (redundant.length > 0) {
			const allEntries = [...redundant.map((r) => r.entry), e];
			const redundantEntries = allEntries.slice(1);
			const waste = sumTokenCost(redundantEntries);
			const file = shortPath(p);
			const firstTurn = redundant[0].turnIndex;
			const lastTurn = e.turnIndex;
			const totalCalls = redundant.length + 1;
			results.push({
				signal: "redundant-read",
				label: "Redundant file reads",
				wastedTokens: waste,
				wastedCost: sumDollarCost(redundantEntries),
				occurrences: redundant.length,
				details: [
					`${file} read ${totalCalls}x in ${totalCalls} calls (turns ${firstTurn}-${lastTurn})`,
				],
				context: { files: [p], turnRange: [firstTurn, lastTurn] },
			});
		}

		reads.push({ path: p, turnIndex: e.turnIndex, entry: e });
	}

	return results;
}

/**
 * D2: Identical args — same tool + same args 3+ times in last 12 calls.
 */
function detectIdenticalArgs(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const calls = data.entries
		.filter((e) => e.toolName && e.args)
		.map((e) => ({
			key: `${e.toolName}|${JSON.stringify(e.args)}`,
			toolName: e.toolName!,
			turnIndex: e.turnIndex,
			entry: e,
		}));

	const window: string[] = [];
	const windowEntries: typeof calls = [];
	for (let i = 0; i < calls.length; i++) {
		const c = calls[i];
		const key = c.key;
		window.push(key);
		windowEntries.push(c);
		if (window.length > 12) {
			window.shift();
			windowEntries.shift();
		}

		const matching = windowEntries.filter((w) => w.key === key);
		if (matching.length >= 3) {
			// Report on first occurrence of the loop
			const waste = sumTokenCost(matching.slice(1).map((m) => m.entry));
			const cost = sumDollarCost(matching.slice(1).map((m) => m.entry));
			results.push({
				signal: "identical-args",
				label: "Identical call loops",
				wastedTokens: waste,
				wastedCost: cost,
				occurrences: matching.length - 1,
				details: [
					`\`${c.toolName}\` identical args ${matching.length}x in last ${window.length} calls (turn ${c.turnIndex})`,
				],
				context: {
					toolName: c.toolName,
					turnRange: [matching[0].turnIndex, matching[matching.length - 1].turnIndex],
				},
			});
			// Clear window to avoid re-reporting
			window.length = 0;
			windowEntries.length = 0;
		}
	}

	return results;
}

/**
 * D3: Bash grep/rg/find — bash used where ripgrep_search exists.
 */
function detectBashGrep(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const bashGrepCalls: SessionEntry[] = [];

	for (const e of data.entries) {
		if (e.toolName !== "bash") continue;
		const cmd = e.text ?? "";
		if (isBashSearch(cmd)) {
			bashGrepCalls.push(e);
		}
	}

	if (bashGrepCalls.length > 0) {
		const waste = sumTokenCost(bashGrepCalls);
		// Subtract estimated ripgrep_search cost (~50 tokens per call)
		const estimatedSearchCost = bashGrepCalls.length * 50;
		const actualWaste = Math.max(0, waste - estimatedSearchCost);
		const details = bashGrepCalls.map(
			(e) =>
				`bash | grep instead of ripgrep_search (turn ${e.turnIndex}): ${(e.text ?? "").slice(0, 80)}`,
		);
		results.push({
			signal: "bash-grep",
			label: "bash | grep instead of ripgrep_search",
			wastedTokens: actualWaste,
			wastedCost: sumDollarCost(bashGrepCalls),
			occurrences: bashGrepCalls.length,
			details,
			context: { toolName: "bash" },
		});
	}

	return results;
}

/**
 * D4: Bash cat/head/tail — bash used where read tool exists.
 */
function detectBashCat(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const bashReadCalls: SessionEntry[] = [];

	for (const e of data.entries) {
		if (e.toolName !== "bash") continue;
		const cmd = e.text ?? "";
		if (isBashFileRead(cmd)) {
			bashReadCalls.push(e);
		}
	}

	if (bashReadCalls.length > 0) {
		const waste = sumTokenCost(bashReadCalls);
		const estimatedReadCost = bashReadCalls.length * 30;
		const actualWaste = Math.max(0, waste - estimatedReadCost);
		const details = bashReadCalls.map(
			(e) =>
				`bash cat/head/tail instead of read (turn ${e.turnIndex}): ${(e.text ?? "").slice(0, 80)}`,
		);
		results.push({
			signal: "bash-cat",
			label: "bash cat/head/tail instead of read",
			wastedTokens: actualWaste,
			wastedCost: sumDollarCost(bashReadCalls),
			occurrences: bashReadCalls.length,
			details,
			context: { toolName: "bash" },
		});
	}

	return results;
}

/**
 * D5: Error loop — tool error followed by retrying same tool with same args (no strategy change).
 *
 * Fixes for #623 / #617:
 * - Arg comparison: flags only when retries share same args (different args = strategy change)
 * - Proportional cost split: wastes only retries beyond the first (first retry is reasonable)
 * - False-positive filtering: skips single errors, different-args retries
 */
function detectErrorLoop(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const errors = data.entries.filter((e) => e.isError);

	for (const err of errors) {
		const errIdx = data.entries.indexOf(err);
		if (errIdx < 0) continue;

		const window = data.entries.slice(errIdx + 1, errIdx + 9);
		const sameToolRetries = window.filter((e) => e.toolName === err.toolName);

		if (sameToolRetries.length < 2) continue;

		// Compare args among retries — if args differ, it's strategy change not loop
		// Group retries by args key; pick the largest group
		const groups = groupBy(sameToolRetries, (e) => stableJsonKey(e.args));
		let largest: { key: string; entries: SessionEntry[] } | undefined;
		for (const g of groups) {
			if (!largest || g.entries.length > largest.entries.length) {
				largest = g;
			}
		}

		if (!largest || largest.entries.length < 2) continue;

		// Proportional waste: only retries beyond the first are wasteful
		const wastefulRetries = largest.entries.slice(1);
		const waste = sumTokenCost(wastefulRetries);
		const cost = sumDollarCost(wastefulRetries);
		const details = [
			`\`${err.toolName}\` errored turn ${err.turnIndex}, retried ${largest.entries.length}x with same args — first retry is reasonable, ${wastefulRetries.length} subsequent retries wasted`,
		];
		results.push({
			signal: "error-loop",
			label: "Error retry loop",
			wastedTokens: waste,
			wastedCost: cost,
			occurrences: wastefulRetries.length,
			details,
			context: {
				toolName: err.toolName,
				turnRange: [
					err.turnIndex,
					largest.entries[largest.entries.length - 1]?.turnIndex ?? err.turnIndex,
				],
			},
		});
	}

	return results;
}

/** Stable JSON key for args comparison. */
function stableJsonKey(args: Record<string, unknown> | undefined): string {
	if (!args) return "__no_args__";
	try {
		const keys = Object.keys(args).sort();
		return JSON.stringify(args, keys);
	} catch {
		return "__no_args__";
	}
}

/** Group entries by a string key. */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Array<{ key: string; entries: T[] }> {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const key = keyFn(item);
		const group = map.get(key);
		if (group) {
			group.push(item);
		} else {
			map.set(key, [item]);
		}
	}
	return Array.from(map.entries()).map(([key, entries]) => ({ key, entries }));
}

/**
 * D6: No batching — 3+ consecutive same-tool calls in different turns.
 */
function detectNoBatch(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const tools = data.entries.filter((e) => e.toolName);

	let runStart = 0;
	for (let i = 1; i <= tools.length; i++) {
		const a = tools[i]?.toolName;
		const b = tools[i - 1]?.toolName;
		if (a === b) continue;

		const runLen = i - runStart;
		if (runLen >= 3 && b) {
			const runTools = tools.slice(runStart, i);
			const startTurn = runTools[0]?.turnIndex ?? 0;
			const endTurn = runTools[runTools.length - 1]?.turnIndex ?? 0;

			if (startTurn === endTurn) continue; // same turn = already batched

			// Turn overhead: ~600 tokens per extra turn
			const extraTurns = endTurn - startTurn;
			const overhead = extraTurns * 600;
			const details = [
				`\`${b}\` called ${runLen}x consecutively across ${extraTurns + 1} turns (turns ${startTurn}-${endTurn}) — could batch into fewer turns`,
			];
			results.push({
				signal: "no-batch",
				label: "Unbatched consecutive calls",
				wastedTokens: overhead,
				wastedCost: 0, // hard to measure dollar cost of turn overhead
				occurrences: extraTurns,
				details,
				context: { toolName: b, turnRange: [startTurn, endTurn] },
			});
		}
		runStart = i;
	}

	return results;
}

/** Tools that perform codebase/external discovery (not waste). */
const DISCOVERY_TOOLS = new Set([
	"ripgrep_search",
	"structural_search",
	"web_search",
	"web_crawl",
	"ask_user",
]);

/**
 * D7: Turn inefficiency — turns with 0 file changes but many tool calls.
 *
 * Fixed for #629:
 * - Bug 1: allReadFiles built incrementally per turn (novelty detection works)
 * - Bug 2: Discovery tools expanded beyond just read
 * - Bug 3: Threshold raised to >=15 tool calls, combined discovery check
 */
function detectTurnInefficiency(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];
	const turns = new Map<number, SessionEntry[]>();

	for (const e of data.entries) {
		if (!turns.has(e.turnIndex)) turns.set(e.turnIndex, []);
		turns.get(e.turnIndex)!.push(e);
	}

	// Build set of turns that changed files
	const fileChangeTurns = new Set<number>();
	for (const e of data.entries) {
		if (
			e.toolName === "edit" ||
			e.toolName === "write" ||
			e.toolName === "writeIfEmpty" ||
			e.toolName === "editExisting"
		) {
			fileChangeTurns.add(e.turnIndex);
		}
	}

	// pre-collect read files per turn (path -> Set<turn>)
	const readFilesPerTurn = new Map<number, Set<string>>();
	for (const e of data.entries) {
		if (e.toolName === "read" && e.type === "tool_use") {
			const p = getEntryPath(e);
			if (!p) continue;
			if (!readFilesPerTurn.has(e.turnIndex)) readFilesPerTurn.set(e.turnIndex, new Set());
			readFilesPerTurn.get(e.turnIndex)!.add(p);
		}
	}

	// Build allReadFiles incrementally (Bug 1 fix)
	const allReadFiles = new Set<string>();

	// Sort turns by index for incremental processing
	const sortedTurns = [...turns.entries()].sort(([a], [b]) => a - b);

	for (const [turnIndex, entries] of sortedTurns) {
		if (turnIndex < 0) continue;
		if (fileChangeTurns.has(turnIndex)) {
			// Still accumulate reads for novelty tracking in future turns
			const readsThisTurn = readFilesPerTurn.get(turnIndex);
			if (readsThisTurn) {
				for (const f of readsThisTurn) allReadFiles.add(f);
			}
			continue;
		}

		// Count tool_use entries as tool calls (Bug 3: count calls, not all entries)
		const toolCalls = entries.filter((e) => e.type === "tool_use" && e.toolName);
		if (toolCalls.length < 15) {
			// Accumulate reads even if below threshold
			const readsThisTurn = readFilesPerTurn.get(turnIndex);
			if (readsThisTurn) {
				for (const f of readsThisTurn) allReadFiles.add(f);
			}
			continue;
		}

		// Check for discovery events (Bug 2: expanded beyond just read)
		let hasDiscovery = false;

		// Check 1: Novel file reads (Bug 1: uses incremental allReadFiles)
		const readsThisTurn = readFilesPerTurn.get(turnIndex);
		if (readsThisTurn) {
			for (const f of readsThisTurn) {
				if (!allReadFiles.has(f)) {
					hasDiscovery = true;
					break;
				}
			}
		}

		// Check 2: Discovery tool calls (ripgrep_search, structural_search, etc.)
		if (!hasDiscovery) {
			for (const e of toolCalls) {
				if (DISCOVERY_TOOLS.has(e.toolName ?? "")) {
					hasDiscovery = true;
					break;
				}
				// Check 3: Non-search/read bash calls
				if (e.toolName === "bash") {
					const cmd = (e.args?.command as string) ?? e.text ?? "";
					if (!isBashSearchOrRead(cmd)) {
						hasDiscovery = true;
						break;
					}
				}
			}
		}

		// Accumulate reads for future novelty tracking
		if (readsThisTurn) {
			for (const f of readsThisTurn) allReadFiles.add(f);
		}

		if (hasDiscovery) continue; // discovery turns are OK

		// Flag: >=15 tool calls, 0 file changes, 0 discovery
		const waste = sumTokenCost(toolCalls);
		const details = [
			`Turn ${turnIndex}: ${toolCalls.length} tool calls, 0 file changes, 0 discovery events`,
		];
		results.push({
			signal: "turn-inefficiency",
			label: "Inefficient turns",
			wastedTokens: waste,
			wastedCost: sumDollarCost(toolCalls),
			occurrences: 1,
			details,
			context: { turnRange: [turnIndex, turnIndex] },
		});
	}

	return results;
}

// ── Code file extension helpers ──

/** Code file extensions that trigger structural-search-underuse detection. */
const CODE_FILE_EXTS = new Set([
	".ts",
	".js",
	".py",
	".tsx",
	".jsx",
	".mts",
	".go",
	".rs",
	".java",
	".c",
	".cpp",
	".swift",
	".kt",
]);

/** True if the file path ends with a known code file extension. */
function isCodeFilePath(filePath: string): boolean {
	const extIdx = filePath.lastIndexOf(".");
	if (extIdx < 0) return false;
	const ext = filePath.slice(extIdx).toLowerCase();
	return CODE_FILE_EXTS.has(ext);
}

/** Entry tool names that indicate a code file touch. */
const CODE_TOUCH_TOOLS = new Set(["read", "edit", "write", "writeIfEmpty", "editExisting"]);

/** Check if a session entry is a code file touch (read/edit/write on a code file). */
function isCodeFileTouch(e: SessionEntry): boolean {
	if (!CODE_TOUCH_TOOLS.has(e.toolName ?? "")) return false;
	const p = getEntryPath(e);
	return p.length > 0 && isCodeFilePath(p);
}

/** Check if a session entry has a given tool name. */
function hasToolName(e: SessionEntry, name: string): boolean {
	return e.toolName === name;
}

/**
 * D8: Structural search underuse — 3+ code file touches with zero structural_search calls.
 */
function detectStructuralSearchUnderuse(data: SessionData): WasteSignal[] {
	const results: WasteSignal[] = [];

	// Check if any structural_search call exists
	const hasStructuralSearch = data.entries.some((e) => hasToolName(e, "structural_search"));
	if (hasStructuralSearch) return results;

	// Collect code file touches
	const codeTouches = data.entries.filter(isCodeFileTouch);
	if (codeTouches.length < 3) return results;

	// Check if all code touches are on the same file path (redundant-read territory, not ours)
	const uniquePaths = new Set(codeTouches.map((e) => getEntryPath(e)));
	if (uniquePaths.size === 1) return results;

	// Calculate waste: sumTokenCost of offending calls minus structural_search overhead
	const waste = sumTokenCost(codeTouches);
	// Estimate 1 structural_search call would have been sufficient
	const estimatedSearchCost = 50;
	const actualWaste = Math.max(0, waste - estimatedSearchCost);

	const details = codeTouches.map(
		(e) => `${e.toolName} ${getEntryPath(e)} (turn ${e.turnIndex}) instead of structural_search`,
	);

	results.push({
		signal: "structural-search-underuse",
		label: "structural_search underused — read/edit on code files without AST query",
		wastedTokens: actualWaste,
		wastedCost: sumDollarCost(codeTouches),
		occurrences: codeTouches.length,
		details,
		context: {
			files: [...uniquePaths],
		},
	});

	return results;
}

// ── Main analysis ──

/**
 * Run all detectors on a parsed session.
 * Returns WasteSignal[] sorted by wastedTokens desc (largest waste first).
 */
export function analyzeSession(data: SessionData): WasteSignal[] {
	const allSignals: WasteSignal[] = [
		...detectRedundantReads(data),
		...detectIdenticalArgs(data),
		...detectBashGrep(data),
		...detectBashCat(data),
		...detectErrorLoop(data),
		...detectNoBatch(data),
		...detectTurnInefficiency(data),
		...detectStructuralSearchUnderuse(data),
	];

	// Dedup by signal+context (same key = same underlying issue, merge)
	const merged = new Map<string, WasteSignal>();
	for (const s of allSignals) {
		const key = `${s.signal}|${s.context.toolName ?? ""}|${(s.context.files ?? []).join(",")}`;
		if (merged.has(key)) {
			const existing = merged.get(key)!;
			existing.wastedTokens += s.wastedTokens;
			existing.wastedCost += s.wastedCost;
			existing.occurrences += s.occurrences;
			existing.details.push(...s.details);
			if (s.context.turnRange) {
				if (!existing.context.turnRange) existing.context.turnRange = s.context.turnRange;
				else {
					existing.context.turnRange = [
						Math.min(existing.context.turnRange[0], s.context.turnRange[0]),
						Math.max(existing.context.turnRange[1], s.context.turnRange[1]),
					];
				}
			}
		} else {
			merged.set(key, { ...s, details: [...s.details] });
		}
	}

	return [...merged.values()].sort((a, b) => b.wastedTokens - a.wastedTokens);
}

/**
 * Build SessionAnalysis from parsed session data + waste signals.
 */
export function buildSessionAnalysis(
	data: SessionData,
	signals: WasteSignal[],
	metadata?: { totalTokens?: number; totalCost?: number },
): SessionAnalysis {
	const totalWasteTokens = signals.reduce((s, w) => s + w.wastedTokens, 0);
	const totalWasteCost = signals.reduce((s, w) => s + w.wastedCost, 0);
	const totalTokens = metadata?.totalTokens ?? totalWasteTokens * 3; // fallback heuristic
	const totalCost = metadata?.totalCost ?? totalWasteCost * 3;

	return {
		sessionId: data.sessionId,
		timestamp: data.timestamp,
		totalTokens,
		totalCost,
		totalWasteTokens,
		totalWasteCost,
		wasteFraction: totalTokens > 0 ? totalWasteTokens / totalTokens : 0,
		wasteBySignal: signals,
	};
}
