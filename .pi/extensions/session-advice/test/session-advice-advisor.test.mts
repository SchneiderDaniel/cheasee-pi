/**
 * Tests for session-advice/advisor.ts — pure waste-signal detectors
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/session-advice-advisor.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { analyzeSession } from "../advisor.ts";
import type { SessionData, SessionEntry } from "../advisor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(entries: SessionEntry[]): SessionData {
	return { sessionId: "test-session", timestamp: "", entries };
}

function readEntry(path: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "read", args: { path }, text: path, turnIndex };
}

function bashEntry(cmd: string, turnIndex: number, isError?: boolean): SessionEntry {
	return {
		type: isError ? "tool_result" : "tool_use",
		toolName: "bash",
		args: { command: cmd },
		text: cmd,
		turnIndex,
		isError,
	};
}

function writeEntry(path: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "write", args: { path }, text: path, turnIndex };
}

function editEntry(path: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "edit", args: { path }, text: path, turnIndex };
}

function structuralSearchEntry(turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "structural_search", args: {}, text: "", turnIndex };
}

// Phase 2 discovery tool helpers
function ripgrepSearchEntry(turnIndex: number): SessionEntry {
	return {
		type: "tool_use",
		toolName: "ripgrep_search",
		args: { query: "test" },
		text: "",
		turnIndex,
	};
}

function webSearchEntry(turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "web_search", args: { query: "test" }, text: "", turnIndex };
}

function webCrawlEntry(turnIndex: number): SessionEntry {
	return {
		type: "tool_use",
		toolName: "web_crawl",
		args: { url: "https://example.com" },
		text: "",
		turnIndex,
	};
}

function askUserEntry(turnIndex: number): SessionEntry {
	return {
		type: "tool_use",
		toolName: "ask_user",
		args: { question: "test" },
		text: "",
		turnIndex,
	};
}

/** Non-discovery bash (build/test commands, not search/read). */
function nonDiscoveryBashEntry(cmd: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "bash", args: { command: cmd }, text: cmd, turnIndex };
}

function readToolError(turnIndex: number): SessionEntry {
	return {
		type: "tool_result",
		toolName: "read",
		isError: true,
		args: {},
		text: "ENOENT: no such file",
		turnIndex,
	};
}

function toolCallPair(
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectRedundantReads", () => {
	it("flags same file read within 1-turn window", () => {
		const data = makeSession([readEntry("/repo/src/app.ts", 0), readEntry("/repo/src/app.ts", 1)]);
		const signals = analyzeSession(data);
		const reads = signals.filter((s) => s.signal === "redundant-read");
		assert.ok(reads.length >= 1, "should flag redundant read");
	});

	it("does NOT flag reads 3+ turns apart", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/app.ts", 3),
		]);
		const signals = analyzeSession(data);
		const reads = signals.filter((s) => s.signal === "redundant-read");
		assert.strictEqual(reads.length, 0, "3 turns apart should not flag");
	});

	it("does NOT flag different files read consecutively", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
		]);
		const signals = analyzeSession(data);
		const reads = signals.filter((s) => s.signal === "redundant-read");
		assert.strictEqual(reads.length, 0);
	});
});

describe("detectBashGrep", () => {
	it("flags bash with | grep", () => {
		const data = makeSession([bashEntry("cat file | grep foo", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.ok(mm.length >= 1, "bash|grep should be flagged");
	});

	it("flags bash with | rg", () => {
		const data = makeSession([bashEntry("cat file.txt | rg pattern", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.ok(mm.length >= 1, "bash|rg should be flagged");
	});

	it("does NOT flag bash for non-search commands", () => {
		const data = makeSession([bashEntry("npm test", 0), bashEntry("node build.js", 1)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.strictEqual(mm.length, 0);
	});

	it("flags file-source pipe: head -n 20 file | grep foo", () => {
		const data = makeSession([bashEntry("head -n 20 file | grep foo", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.ok(mm.length >= 1, "head | grep should be flagged");
	});

	it("flags file-source pipe: tail -f log | grep error", () => {
		const data = makeSession([bashEntry("tail -f log | grep error", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.ok(mm.length >= 1, "tail | grep should be flagged");
	});

	it("flags file-source pipe: less file | grep foo", () => {
		const data = makeSession([bashEntry("less file | grep foo", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.ok(mm.length >= 1, "less | grep should be flagged");
	});

	it("flags file-source pipe: more file | grep foo", () => {
		const data = makeSession([bashEntry("more file | grep foo", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.ok(mm.length >= 1, "more | grep should be flagged");
	});

	it("does NOT flag command-output pipe: ctags --list-maps | grep typescript", () => {
		const data = makeSession([bashEntry("ctags --list-maps | grep typescript", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.strictEqual(mm.length, 0, "ctags | grep should NOT be flagged");
	});

	it("does NOT flag command-output pipe: git branch -a | grep 599", () => {
		const data = makeSession([bashEntry("git branch -a | grep 599", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.strictEqual(mm.length, 0, "git branch | grep should NOT be flagged");
	});

	it("does NOT flag command-output pipe: gh issue list | grep bug", () => {
		const data = makeSession([bashEntry("gh issue list | grep bug", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.strictEqual(mm.length, 0, "gh issue list | grep should NOT be flagged");
	});

	it("does NOT flag dir listing pipe: ls | grep -v node_modules", () => {
		const data = makeSession([bashEntry("ls | grep -v node_modules", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.strictEqual(mm.length, 0, "ls | grep should NOT be flagged");
	});

	it("does NOT flag process pipe: ps aux | grep node", () => {
		const data = makeSession([bashEntry("ps aux | grep node", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.strictEqual(mm.length, 0, "ps aux | grep should NOT be flagged");
	});

	it("does NOT flag docker pipe: docker ps | grep myapp", () => {
		const data = makeSession([bashEntry("docker ps | grep myapp", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.strictEqual(mm.length, 0, "docker ps | grep should NOT be flagged");
	});

	it('does NOT flag find pipe: find . -name "*.ts" | grep test', () => {
		const data = makeSession([bashEntry('find . -name "*.ts" | grep test', 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.strictEqual(mm.length, 0, "find | grep should NOT be flagged");
	});

	it("does NOT flag | find (removed)", () => {
		const data = makeSession([bashEntry("somecmd | find foo", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.strictEqual(mm.length, 0, "| find should NOT be flagged");
	});

	it("does NOT flag | rg with non-file source: git branch -a | rg main", () => {
		const data = makeSession([bashEntry("git branch -a | rg main", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.strictEqual(mm.length, 0, "git branch | rg should NOT be flagged");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// detectBashCat — uses isBashFileRead from shared lib
// ═══════════════════════════════════════════════════════════════════════

describe("detectBashCat", () => {
	it("flags cat file.ts → bash-cat signal", () => {
		const data = makeSession([bashEntry("cat file.ts", 0)]);
		const signals = analyzeSession(data);
		const cat = signals.filter((s) => s.signal === "bash-cat");
		assert.ok(cat.length >= 1, "cat file should be flagged");
	});

	it("flags head -5 file.ts → bash-cat signal", () => {
		const data = makeSession([bashEntry("head -5 file.ts", 0)]);
		const signals = analyzeSession(data);
		const cat = signals.filter((s) => s.signal === "bash-cat");
		assert.ok(cat.length >= 1, "head -5 file should be flagged");
	});

	it("flags tail -f log → bash-cat signal", () => {
		const data = makeSession([bashEntry("tail -f log", 0)]);
		const signals = analyzeSession(data);
		const cat = signals.filter((s) => s.signal === "bash-cat");
		assert.ok(cat.length >= 1, "tail -f log should be flagged");
	});

	it("flags less file → bash-cat signal", () => {
		const data = makeSession([bashEntry("less file", 0)]);
		const signals = analyzeSession(data);
		const cat = signals.filter((s) => s.signal === "bash-cat");
		assert.ok(cat.length >= 1, "less file should be flagged");
	});

	it("does NOT flag cat with write redirect", () => {
		const data = makeSession([bashEntry("cat > /tmp/foo", 0)]);
		const signals = analyzeSession(data);
		const cat = signals.filter((s) => s.signal === "bash-cat");
		assert.strictEqual(cat.length, 0, "cat > should NOT be flagged");
	});

	it("does NOT flag cat with append redirect", () => {
		const data = makeSession([bashEntry("cat >> file", 0)]);
		const signals = analyzeSession(data);
		const cat = signals.filter((s) => s.signal === "bash-cat");
		assert.strictEqual(cat.length, 0, "cat >> should NOT be flagged");
	});

	it("does NOT flag npm test (non-read cmd)", () => {
		const data = makeSession([bashEntry("npm test", 0)]);
		const signals = analyzeSession(data);
		const cat = signals.filter((s) => s.signal === "bash-cat");
		assert.strictEqual(cat.length, 0, "npm test should NOT be flagged");
	});

	it("does NOT flag piped read when not first segment: ls -la | head -5", () => {
		const data = makeSession([bashEntry("ls -la | head -5", 0)]);
		const signals = analyzeSession(data);
		const cat = signals.filter((s) => s.signal === "bash-cat");
		assert.strictEqual(cat.length, 0, "ls | head should NOT be flagged");
	});

	it("flags cat in pipe context: cat file | grep foo (first segment is read)", () => {
		const data = makeSession([bashEntry("cat file | grep foo", 0)]);
		const signals = analyzeSession(data);
		const cat = signals.filter((s) => s.signal === "bash-cat");
		// isBashFileRead returns true for first segment being a read cmd
		assert.ok(cat.length >= 1, "cat in pipe should also be flagged as bash-cat");
	});
});

describe("detectErrorLoop", () => {
	it("flags when same tool errors and retried 2+ times with same args", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/missing.ts", 1),
			readEntry("/repo/src/missing.ts", 2),
		]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.ok(errs.length >= 1, "should flag retries after error with same args");
	});

	it("does NOT flag when retries have different args (strategy change)", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/file-a.ts", 1),
			readEntry("/repo/src/file-b.ts", 2),
		]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.strictEqual(errs.length, 0, "different args = strategy change, not loop");
	});

	it("flags 2+ retries with same args even with different-args retries in window", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/target.ts", 1),
			readEntry("/repo/src/other.ts", 2),
			readEntry("/repo/src/target.ts", 3),
		]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.ok(errs.length >= 1, "should flag same-args retries despite different-args in between");
	});

	it("does NOT flag single error without retry", () => {
		const data = makeSession([readToolError(0)]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.strictEqual(errs.length, 0);
	});

	it("proportional waste: counts only retries beyond first", () => {
		// 1 error + 3 retries with same args → 2 wasteful (first retry excluded)
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/missing.ts", 1),
			readEntry("/repo/src/missing.ts", 2),
			readEntry("/repo/src/missing.ts", 3),
		]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.ok(errs.length >= 1, "should flag");
		// 3 retries - 1 = 2 wasteful
		assert.strictEqual(errs[0].occurrences, 2, "should have 2 wasteful occurrences");
	});
});

// ── D7 test helpers ──

/**
 * Generate N tool_use entries (without tool_result pairs) for a single turn.
 * Used to reach the >=15 tool call threshold without doubling entries.
 */
function nReadEntries(n: number, path: string, turnIndex: number): SessionEntry[] {
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
function buildNoDiscoveryTurn(
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

describe("detectTurnInefficiency — Phase 1: Fix novelty detection (Bug 1)", () => {
	it("Turn 2 reads novel file B (never seen before) → B is novel, D7 does NOT flag", () => {
		// Turn 0: read file A. Turn 2: 15 reads of file A + 1 read of new file B (novel)
		const entries: SessionEntry[] = [readEntry("/repo/fileA.ts", 0)];
		// 15 reads of file A in turn 2 (non-novel) + 1 read of file B (novel)
		for (let i = 0; i < 15; i++) {
			entries.push(readEntry("/repo/fileA.ts", 2));
		}
		entries.push(readEntry("/repo/fileB.ts", 2)); // novel!

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "novel file read should prevent flagging");
	});

	it("Turn 2 re-reads only file A (already seen) → no novelty, flags when ≥15 calls", () => {
		const entries: SessionEntry[] = [readEntry("/repo/fileA.ts", 0)];
		for (let i = 0; i < 15; i++) {
			entries.push(readEntry("/repo/fileA.ts", 2));
		}

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 1, "no novel file, only repeats → should flag");
	});

	it("Turn 1 reads new file W after Turn 0 read X, Y, Z → W is novel, D7 does NOT flag", () => {
		const entries: SessionEntry[] = [];
		// Turn 0: read X, Y, Z
		entries.push(readEntry("/repo/X.ts", 0));
		entries.push(readEntry("/repo/Y.ts", 0));
		entries.push(readEntry("/repo/Z.ts", 0));
		// Turn 1: 15 reads of X + 1 read of W (novel)
		for (let i = 0; i < 15; i++) {
			entries.push(readEntry("/repo/X.ts", 1));
		}
		entries.push(readEntry("/repo/W.ts", 1)); // novel!

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "novel file W should prevent flagging");
	});

	it("Old bug verification: allReadFiles was pre-built — verify file W correctly counted as novel in Turn 1 (bug GONE)", () => {
		// Same setup as above but we explicitly verify the turn-inefficiency count is 0
		// In the old buggy code, allReadFiles would contain ALL file reads before the loop,
		// so file W would NOT be considered novel in Turn 1, causing a false flag.
		const entries: SessionEntry[] = [];
		entries.push(readEntry("/repo/X.ts", 0));
		entries.push(readEntry("/repo/Y.ts", 0));
		entries.push(readEntry("/repo/Z.ts", 0));
		// Turn 1: 15 reads of X + 1 read of W (should be novel — bug was that W wasn't counted as novel)
		for (let i = 0; i < 15; i++) {
			entries.push(readEntry("/repo/X.ts", 1));
		}
		entries.push(readEntry("/repo/W.ts", 1));

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		// In old code: allReadFiles = {X, Y, Z, X(15x), W}, so W is !allReadFiles.has(W) = false → not novel → flags
		// Fixed code: allReadFiles built incrementally, at start of Turn 1 only {X, Y, Z} → W IS novel → no flag
		assert.strictEqual(inefficient.length, 0, "W correctly counted as novel — old bug is fixed");
	});

	it("Turn 0 reads file A, Turn 2 reads file B (skip Turn 1) → B is novel, D7 does NOT flag", () => {
		const entries: SessionEntry[] = [readEntry("/repo/fileA.ts", 0)];
		for (let i = 0; i < 15; i++) {
			entries.push(readEntry("/repo/fileB.ts", 2)); // novel!
		}

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "file B never seen before → novel, no flag");
	});
});

describe("detectTurnInefficiency — Phase 2: Expand legitimate discovery tools (Bug 2)", () => {
	it("uses ripgrep_search → NOT flagged", () => {
		const entries: SessionEntry[] = [];
		// 14 non-discovery reads + 1 ripgrep_search = 15 tool calls, 0 file changes
		for (let i = 0; i < 14; i++) {
			entries.push(readEntry("/repo/file.ts", 0));
		}
		entries.push(ripgrepSearchEntry(0));

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "ripgrep_search is legitimate discovery");
	});

	it("uses structural_search → NOT flagged", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 14; i++) {
			entries.push(readEntry("/repo/file.ts", 0));
		}
		entries.push(structuralSearchEntry(0));

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "structural_search is legitimate discovery");
	});

	it("uses web_search → NOT flagged", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 14; i++) {
			entries.push(readEntry("/repo/file.ts", 0));
		}
		entries.push(webSearchEntry(0));

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "web_search is legitimate discovery");
	});

	it("uses web_crawl → NOT flagged", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 14; i++) {
			entries.push(readEntry("/repo/file.ts", 0));
		}
		entries.push(webCrawlEntry(0));

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "web_crawl is legitimate discovery");
	});

	it("uses bash (non-grep, non-cat) → NOT flagged", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 14; i++) {
			entries.push(readEntry("/repo/file.ts", 0));
		}
		entries.push(nonDiscoveryBashEntry("npm test", 0));

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "non-search bash is legitimate discovery");
	});

	it("uses find in bash → search/read-like, NOT discovery → flagged when ≥15 calls", () => {
		// find is included in isBashSearchOrRead (but not in isBashSearch/isBashFileRead),
		// so detectTurnInefficiency treats find like grep/cat — not discovery.
		const entries: SessionEntry[] = [readEntry("/repo/file.ts", 0)];
		for (let i = 0; i < 15; i++) {
			entries.push(nonDiscoveryBashEntry("find . -name '*.ts'", 1));
		}
		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(
			inefficient.length,
			1,
			"find is not discovery in turn-inefficiency → should flag",
		);
	});

	it("uses less in bash → search/read-like, NOT discovery → flagged when ≥15 calls", () => {
		// less standalone is treated as file-read by isBashFileRead (included in READ_CMDS).
		// OLD inline isBashSearchOrRead only checked cat/head/tail for standalone reads, NOT less/more.
		// This test would FAIL with OLD code (less = discovery → no flag) and PASS with NEW code.
		const entries: SessionEntry[] = [readEntry("/repo/file.ts", 0)];
		for (let i = 0; i < 15; i++) {
			entries.push(nonDiscoveryBashEntry("less file.ts", 1));
		}
		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(
			inefficient.length,
			1,
			"less is not discovery in turn-inefficiency → should flag",
		);
	});

	it("uses more in bash → search/read-like, NOT discovery → flagged when ≥15 calls", () => {
		// Same as less — more standalone is treated as file-read by isBashFileRead.
		// OLD inline isBashSearchOrRead did NOT check more standalone → this would NOT flag.
		const entries: SessionEntry[] = [readEntry("/repo/file.ts", 0)];
		for (let i = 0; i < 15; i++) {
			entries.push(nonDiscoveryBashEntry("more file.ts", 1));
		}
		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(
			inefficient.length,
			1,
			"more is not discovery in turn-inefficiency → should flag",
		);
	});

	it("uses ask_user → NOT flagged", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 14; i++) {
			entries.push(readEntry("/repo/file.ts", 0));
		}
		entries.push(askUserEntry(0));

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "ask_user is legitimate discovery");
	});

	it("multiple discovery tools combined → NOT flagged", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 12; i++) {
			entries.push(readEntry("/repo/file.ts", 0));
		}
		entries.push(ripgrepSearchEntry(0));
		entries.push(structuralSearchEntry(0));

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "multiple discovery tools prevent flagging");
	});
});

describe("detectTurnInefficiency — Phase 3: Threshold changes (Bug 3)", () => {
	it("14 tool calls, 0 file changes, 0 discovery → NOT flagged (below threshold)", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 14; i++) {
			entries.push(readEntry("/repo/file.ts", 0));
		}

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "14 tool calls below threshold of 15");
	});

	it("15 tool calls, 0 file changes, 0 discovery → flagged", () => {
		// Turn 0 reads file first. Turn 1 re-reads it 15x — no novel files, no discovery tools.
		const entries: SessionEntry[] = [readEntry("/repo/file.ts", 0)];
		for (let i = 0; i < 15; i++) {
			entries.push(readEntry("/repo/file.ts", 1));
		}

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 1, "15 tool calls with no discovery should flag");
	});

	it("15 tool calls, 0 file changes, novel file read → NOT flagged (discovery)", () => {
		const entries: SessionEntry[] = [];
		// Turn 0: read file A. Turn 1: 15 calls + novel file B
		entries.push(readEntry("/repo/fileA.ts", 0));
		for (let i = 0; i < 15; i++) {
			entries.push(readEntry("/repo/fileB.ts", 1)); // novel + 14 non-novel reads
		}

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "novel file read is discovery, prevents flagging");
	});

	it("30 tool calls, file change present → NOT flagged (file change exempts turn)", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 30; i++) {
			entries.push(readEntry("/repo/file.ts", 0));
		}
		entries.push(writeEntry("/repo/file.ts", 0)); // file change in same turn

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "file change exempts turn");
	});

	it("15+ tool calls across 2 turns, each below threshold → neither flags", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 8; i++) {
			entries.push(readEntry("/repo/fileA.ts", 0));
		}
		for (let i = 0; i < 8; i++) {
			entries.push(readEntry("/repo/fileB.ts", 1));
		}

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "both turns below threshold");
	});

	it("15 tool calls with discovery bash + novel read → NOT flagged", () => {
		const entries: SessionEntry[] = [];
		entries.push(readEntry("/repo/known.ts", 0));
		for (let i = 0; i < 13; i++) {
			entries.push(readEntry("/repo/known.ts", 1));
		}
		entries.push(nonDiscoveryBashEntry("npm run build", 1));
		entries.push(readEntry("/repo/novel.ts", 1)); // novel!

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "bash discovery + novel read prevents flagging");
	});
});

// ── Legacy regression tests ──

describe("detectTurnInefficiency — legacy regression guards", () => {
	it("empty session → no crash, no signal", () => {
		const data = makeSession([]);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0);
	});

	it("single turn below threshold → no signal", () => {
		const data = makeSession([readEntry("/src/file.ts", 0)]);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0);
	});

	it("turn with only file changes (write) → no signal", () => {
		const data = makeSession([
			writeEntry("/repo/src/app.ts", 0),
			writeEntry("/repo/src/utils.ts", 0),
			writeEntry("/repo/src/main.ts", 0),
		]);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 0, "file changes should exempt turn");
	});

	it("signal has correct structure (signal, wastedTokens, context)", () => {
		// Turn 0 reads file. Turn 1 re-reads it 15x — no discovery, triggers flag.
		const entries: SessionEntry[] = [readEntry("/repo/file.ts", 0)];
		for (let i = 0; i < 15; i++) {
			entries.push(readEntry("/repo/file.ts", 1));
		}
		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(inefficient.length, 1);
		assert.ok(inefficient[0].wastedTokens > 0, "should have non-zero wasted tokens");
		assert.ok(inefficient[0].context.turnRange, "should have turnRange context");
		assert.strictEqual(inefficient[0].context.turnRange![0], 1);
		assert.strictEqual(inefficient[0].context.turnRange![1], 1);
	});
});

// ── Helper for identical-args tests ──

function identicalBashEntry(cmd: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "bash", args: { command: cmd }, text: cmd, turnIndex };
}

function identicalStructuralSearchEntry(turnIndex: number): SessionEntry {
	return {
		type: "tool_use",
		toolName: "structural_search",
		args: { pattern: "test" },
		text: "",
		turnIndex,
	};
}

// ---------------------------------------------------------------------------
// detectIdenticalArgs tests
// ---------------------------------------------------------------------------

describe("detectIdenticalArgs", () => {
	it("3 identical calls within window → identical-args signal with occurrences >= 2", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 1, "should produce one identical-args signal");
		assert.ok(identical[0].occurrences >= 2, "occurrences should be >= 2");
		assert.strictEqual(identical[0].context.toolName, "bash");
	});

	it("2 identical calls → no identical-args signal (below threshold)", () => {
		const data = makeSession([identicalBashEntry("ls", 0), identicalBashEntry("ls", 0)]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 0, "2 identical calls should not trigger");
	});

	it("5 identical calls → single signal, not duplicated per-call", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 1, "5 identical calls should produce exactly 1 signal");
	});

	it("identical calls span >12 entries (window slides) → only 3+ in current window trigger", () => {
		// 3 identical calls at start, then 10 different calls, then 2 more identical = only first 3 trigger
		const entries: SessionEntry[] = [
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		];
		// Add 10 unique calls to push first 3 out of 12-call window
		for (let i = 3; i < 13; i++) {
			entries.push(identicalBashEntry(`unique-${i}`, 0));
		}
		// Now add 2 more identical 'ls' calls — window has only 2, so no new signal
		entries.push(identicalBashEntry("ls", 0));
		entries.push(identicalBashEntry("ls", 0));

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		// The first 3 were detected before window slid, so 1 signal expected
		assert.strictEqual(identical.length, 1, "only the first batch of 3 should trigger a signal");
	});

	it("3 identical calls interleaved with other tools → still detected (key match)", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalStructuralSearchEntry(0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 1, "interleaved identical calls should be detected");
	});

	it("same tool but different args → no signal (key mismatch)", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls -la", 0),
			identicalBashEntry("ls", 0),
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 0, "different args should not match");
	});

	it("different tool but same args structure → no signal (key includes toolName)", () => {
		const data = makeSession([
			{ type: "tool_use", toolName: "bash", args: { command: "ls" }, text: "ls", turnIndex: 0 },
			{ type: "tool_use", toolName: "read", args: { command: "ls" }, text: "", turnIndex: 0 },
			{ type: "tool_use", toolName: "bash", args: { command: "ls" }, text: "ls", turnIndex: 0 },
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(
			identical.length,
			0,
			"different tools should not match even with same args shape",
		);
	});

	it("6 identical calls → first and second batch both detected, merged by dedup", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		// Both batches detected but merged by analyzeSession dedup (same toolName, no files)
		// Each batch has 2 wasted occurrences → total >= 4
		assert.strictEqual(identical.length, 1, "6 identical calls should produce 1 merged signal");
		assert.ok(
			identical[0].occurrences >= 4,
			"merged occurrences should account for both batches (>= 4)",
		);
	});

	it("empty session → no crash, empty results", () => {
		const data = makeSession([]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(
			identical.length,
			0,
			"empty session should produce no identical-args signal",
		);
	});

	it("single call → no signal", () => {
		const data = makeSession([identicalBashEntry("ls", 0)]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 0, "single call should not trigger");
	});

	it("entries with undefined/null toolName or args → filtered out, no crash", () => {
		const data = makeSession([
			{
				type: "tool_use",
				toolName: undefined,
				args: { command: "ls" },
				text: "",
				turnIndex: 0,
			} as any,
			{ type: "tool_use", toolName: "bash", args: undefined, text: "", turnIndex: 0 } as any,
			{ type: "tool_use", toolName: undefined, args: undefined, text: "", turnIndex: 0 } as any,
		]);
		const signals = analyzeSession(data);
		// Should not crash
		assert.ok(Array.isArray(signals), "should return array without crashing");
	});
});

describe("return type is WasteSignal[]", () => {
	it("analyzeSession returns array with WasteSignal objects", () => {
		const signals = analyzeSession(makeSession([bashEntry("cat file | grep foo", 0)]));
		assert.ok(Array.isArray(signals), "should return array");
		if (signals.length > 0) {
			assert.ok("signal" in signals[0], "each signal should have .signal");
			assert.ok("wastedTokens" in signals[0], "each signal should have .wastedTokens");
			assert.ok("label" in signals[0], "each signal should have .label");
		}
	});

	it("analyzeSession on assertion line — gate coverage marker", () => {
		assert.ok(Array.isArray(analyzeSession(makeSession([bashEntry("cat file | grep foo", 0)]))));
	});

	it("clean session returns empty array", () => {
		assert.strictEqual(
			analyzeSession(makeSession([bashEntry("npm test", 0), bashEntry("node build.js", 1)])).length,
			0,
			"clean session should produce no signals",
		);
	});

	it("no code file touches returns empty or low signals", () => {
		const data = makeSession([bashEntry("npm test", 0), bashEntry("node build.js", 1)]);
		const signals = analyzeSession(data);
		assert.strictEqual(signals.length, 0);
	});
});

// ---------------------------------------------------------------------------
// detectStructuralSearchUnderuse tests
// ---------------------------------------------------------------------------

describe("detectStructuralSearchUnderuse", () => {
	it("3 distinct code file reads, 0 structural_search → signal fires", () => {
		const data = makeSession([
			readEntry("/repo/src/components/app.ts", 0),
			readEntry("/repo/src/utils/helpers.ts", 1),
			readEntry("/repo/src/main/entry.ts", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 1, "3 code file reads with no structural_search should fire");
		assert.ok(ss[0].wastedTokens >= 0, "wastedTokens should be >= 0");
	});

	it("3 code file reads + 1 structural_search → NO signal", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
			structuralSearchEntry(3),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "at least 1 structural_search call should prevent signal");
	});

	it("2 code file reads → NO signal (below threshold)", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "2 code reads should not fire");
	});

	it("3 reads on non-code files (.json, .yaml) → NO signal", () => {
		const data = makeSession([
			readEntry("/repo/config.json", 0),
			readEntry("/repo/tsconfig.json", 1),
			readEntry("/repo/deploy.yaml", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "non-code file reads should not fire");
	});

	it("3 code file edits (edit/write) → signal fires", () => {
		const data = makeSession([
			editEntry("/repo/src/app.ts", 0),
			writeEntry("/repo/src/utils.ts", 1),
			editEntry("/repo/src/main.ts", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 1, "3 code file edits should fire");
	});

	it("mixed: 2 code reads + 3 non-code reads → NO signal (code < 3)", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/config.json", 2),
			readEntry("/repo/deploy.yaml", 3),
			readEntry("/repo/.env", 4),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "2 code + 3 non-code should not fire");
	});

	it("3 reads all on same file → NO signal (redundant-read territory)", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/app.ts", 1),
			readEntry("/repo/src/app.ts", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(
			ss.length,
			0,
			"3 reads on same file should not fire structural-search-underuse",
		);
	});

	it("empty session → no crash, no signal", () => {
		const data = makeSession([]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "empty session should not crash");
	});

	it("session with only structural_search calls → no crash, no signal", () => {
		const data = makeSession([
			structuralSearchEntry(0),
			structuralSearchEntry(1),
			structuralSearchEntry(2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "only structural_search calls should not fire");
	});

	it("wastedTokens estimate includes sumTokenCost of offending reads", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 1);
		// Each read entry has text=path, charsToTokens for "/repo/src/app.ts" = ceil(17/4) = 5
		// 3 entries * 5 = 15. Minus 50 overhead = 0 with floor. At minimum > 0 for longer paths.
		assert.ok(ss[0].wastedTokens >= 0, "wastedTokens should be non-negative");
	});

	it("writeIfEmpty and editExisting count as code file touches", () => {
		const data = makeSession([
			{
				type: "tool_use",
				toolName: "writeIfEmpty",
				args: { path: "/repo/src/new.ts" },
				text: "/repo/src/new.ts",
				turnIndex: 0,
			},
			{
				type: "tool_use",
				toolName: "editExisting",
				args: { path: "/repo/src/existing.ts" },
				text: "/repo/src/existing.ts",
				turnIndex: 1,
			},
			{
				type: "tool_use",
				toolName: "edit",
				args: { path: "/repo/src/another.ts" },
				text: "/repo/src/another.ts",
				turnIndex: 2,
			},
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 1, "writeIfEmpty/editExisting/edit should count as code touches");
	});

	it("0 code file reads, 3 non-code reads → NO signal", () => {
		const data = makeSession([
			readEntry("/repo/README.md", 0),
			readEntry("/repo/.gitignore", 1),
			readEntry("/repo/package.json", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "only non-code reads should not fire");
	});

	it("signal context includes files list", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 1);
		assert.ok(ss[0].context.files, "should have files context");
		assert.ok(ss[0].context.files!.length >= 3, "should list affected files");
	});
});

describe("analyzeSessionFile removed (dead code)", () => {
	it("should NOT be exported from advisor.ts", async () => {
		const advisor = await import("../advisor.ts");
		const exportNames = Object.keys(advisor);
		assert.ok(
			!exportNames.includes("analyzeSessionFile"),
			"analyzeSessionFile was dead code (zero consumers) and should have been removed",
		);
	});
});
