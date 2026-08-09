/**
 * Tests for context-info extension (Agent Castle Terminal Revamp)
 *
 * Covers: formatTokens, resolveColor, pickThreshold, loadConfig,
 * thinkingIcon, thinkingColor, getWorktreeName, getGitBranch,
 * and integration with custom footer.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/context-status-bar.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Duplicated helpers from .pi/extensions/context-info.ts
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

interface ThresholdEntry {
	maxTokens: number | null;
	color: string;
}

const DEFAULT_THRESHOLDS: ThresholdEntry[] = [
	{ maxTokens: 100_000, color: "green" },
	{ maxTokens: 150_000, color: "orange" },
	{ maxTokens: null, color: "red" },
];

function pickThreshold(tokens: number, thresholds: ThresholdEntry[]): ThresholdEntry {
	const sorted = [...thresholds].sort((a, b) => {
		if (a.maxTokens === null) return 1;
		if (b.maxTokens === null) return -1;
		return a.maxTokens - b.maxTokens;
	});
	for (const entry of sorted) {
		if (entry.maxTokens === null) return entry;
		if (tokens <= entry.maxTokens) return entry;
	}
	return sorted[sorted.length - 1]!;
}

function thinkingIcon(level: string | undefined): string {
	switch (level) {
		case "off":
			return "○";
		case "minimal":
			return "◐";
		case "low":
			return "◑";
		case "medium":
			return "◒";
		case "high":
			return "◓";
		case "xhigh":
			return "●";
		default:
			return "·";
	}
}

function thinkingColor(level: string | undefined): string {
	switch (level) {
		case "off":
			return "dim";
		case "minimal":
			return "dim";
		case "low":
			return "muted";
		case "medium":
			return "accent";
		case "high":
			return "warning";
		case "xhigh":
			return "error";
		default:
			return "dim";
	}
}

function getWorktreeName(cwd: string): string | null {
	try {
		const gitFile = `${cwd}/.git`;
		if (!existsSync(gitFile)) return null;
		const content = readFileSync(gitFile, "utf-8");
		const match = content.match(/^gitdir:\s*(.+)$/m);
		if (!match) return null;
		const gitDir = match[1]!.trim();
		const wtMatch = gitDir.match(/worktrees\/(.+?)(\/|$)/);
		return wtMatch ? wtMatch[1]! : "worktree";
	} catch {
		return null;
	}
}

interface TpsSample {
	time: number;
	cumulativeTokens: number;
}

interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
	showTimer: boolean;
	showTps: boolean;
	showCache: boolean;
}

/** Compute tokens per second from rolling buffer (30s window) */
function computeTps(samples: TpsSample[]): number | null {
	if (samples.length < 2) return null;

	const now = Date.now();
	const cutoff = now - 30_000;

	// Filter to 30s window
	const active = samples.filter((s) => s.time >= cutoff);
	if (active.length < 2) return null;

	const first = active[0]!;
	const last = active[active.length - 1]!;
	const tokenDelta = last.cumulativeTokens - first.cumulativeTokens;
	const timeDelta = last.time - first.time;

	if (timeDelta <= 0) return null;
	if (tokenDelta <= 0) return null;

	return (tokenDelta / timeDelta) * 1000;
}

/** Format TPS value to display string */
function formatTps(tps: number | null): string {
	if (tps === null) return "-- t/s";
	if (tps < 0.1) return "0.0 t/s";
	if (tps > 999.9) return `${Math.round(tps)} t/s`;
	return `${tps.toFixed(1)} t/s`;
}

function loadConfig(rawSettings: Record<string, unknown> | null): {
	config: ContextStatusBarConfig | null;
	warnings: string[];
} {
	const warnings: string[] = [];
	const defaults: ContextStatusBarConfig = {
		enabled: true,
		thresholds: DEFAULT_THRESHOLDS,
		showTimer: true,
		showTps: true,
		showCache: true,
	};

	if (!rawSettings || typeof rawSettings !== "object") {
		return { config: defaults, warnings };
	}

	const raw = (rawSettings as Record<string, unknown>)["contextStatusBar"];
	if (raw === undefined) {
		return { config: defaults, warnings };
	}
	if (typeof raw !== "object" || raw === null) {
		warnings.push("contextStatusBar must be an object; using defaults");
		return { config: defaults, warnings };
	}

	const cfg = raw as Record<string, unknown>;

	let enabled = true;
	if ("enabled" in cfg) {
		if (typeof cfg.enabled === "boolean") {
			enabled = cfg.enabled;
		} else {
			warnings.push("contextStatusBar.enabled must be boolean; using true");
		}
	}

	if (enabled === false) return { config: null, warnings };

	let thresholds: ThresholdEntry[];
	if (!Array.isArray(cfg.thresholds) || cfg.thresholds.length === 0) {
		warnings.push("contextStatusBar.thresholds missing or empty; falling back to defaults");
		thresholds = DEFAULT_THRESHOLDS;
	} else {
		const parsed: ThresholdEntry[] = [];
		for (const entry of cfg.thresholds) {
			if (typeof entry !== "object" || entry === null) continue;
			const e = entry as Record<string, unknown>;
			const maxTokens =
				e.maxTokens === null || e.maxTokens === undefined ? null : Number(e.maxTokens);
			const color = typeof e.color === "string" ? e.color : "";
			if (maxTokens !== null && !Number.isFinite(maxTokens)) continue;
			if (!color) continue;
			parsed.push({ maxTokens: maxTokens as number | null, color });
		}
		if (parsed.length === 0) {
			warnings.push("contextStatusBar.thresholds has no valid entries; falling back to defaults");
			thresholds = DEFAULT_THRESHOLDS;
		} else {
			thresholds = parsed;
		}
	}

	// Parse showTimer
	let showTimer = true;
	if ("showTimer" in cfg) {
		if (typeof cfg.showTimer === "boolean") {
			showTimer = cfg.showTimer;
		} else {
			warnings.push("contextStatusBar.showTimer must be boolean; using true");
		}
	}

	// Parse showTps
	let showTps = true;
	if ("showTps" in cfg) {
		if (typeof cfg.showTps === "boolean") {
			showTps = cfg.showTps;
		} else {
			warnings.push("contextStatusBar.showTps must be boolean; using true");
		}
	}

	// Parse showCache
	let showCache = true;
	if ("showCache" in cfg) {
		if (typeof cfg.showCache === "boolean") {
			showCache = cfg.showCache;
		} else {
			warnings.push("contextStatusBar.showCache must be boolean; using true");
		}
	}

	return { config: { enabled, thresholds, showTimer, showTps, showCache }, warnings };
}

// ---------------------------------------------------------------------------
// formatTokens tests
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
	it("formats K values", () => {
		assert.strictEqual(formatTokens(12_000), "12.0K");
		assert.strictEqual(formatTokens(1_000), "1.0K");
		assert.strictEqual(formatTokens(100_000), "100.0K");
		assert.strictEqual(formatTokens(999_999), "1000.0K");
	});

	it("formats M values", () => {
		assert.strictEqual(formatTokens(1_000_000), "1.0M");
		assert.strictEqual(formatTokens(2_500_000), "2.5M");
	});

	it("formats small values (no suffix)", () => {
		assert.strictEqual(formatTokens(0), "0");
		assert.strictEqual(formatTokens(999), "999");
		assert.strictEqual(formatTokens(42), "42");
	});
});

// ---------------------------------------------------------------------------
// pickThreshold tests
// ---------------------------------------------------------------------------

describe("pickThreshold", () => {
	const thresholds = DEFAULT_THRESHOLDS;

	it("≤100K returns green", () => {
		assert.strictEqual(pickThreshold(0, thresholds).color, "green");
		assert.strictEqual(pickThreshold(50_000, thresholds).color, "green");
		assert.strictEqual(pickThreshold(100_000, thresholds).color, "green");
	});

	it(">100K and ≤150K returns orange", () => {
		assert.strictEqual(pickThreshold(100_001, thresholds).color, "orange");
		assert.strictEqual(pickThreshold(150_000, thresholds).color, "orange");
	});

	it(">150K returns red", () => {
		assert.strictEqual(pickThreshold(150_001, thresholds).color, "red");
		assert.strictEqual(pickThreshold(500_000, thresholds).color, "red");
	});

	it("handles custom thresholds", () => {
		const custom: ThresholdEntry[] = [
			{ maxTokens: 50_000, color: "green" },
			{ maxTokens: null, color: "orange" },
		];
		assert.strictEqual(pickThreshold(30_000, custom).color, "green");
		assert.strictEqual(pickThreshold(60_000, custom).color, "orange");
	});

	it("null catch-all always matches last", () => {
		const custom: ThresholdEntry[] = [
			{ maxTokens: 10_000, color: "green" },
			{ maxTokens: null, color: "red" },
		];
		assert.strictEqual(pickThreshold(50_000, custom).color, "red");
	});

	it("sorts thresholds by maxTokens ascending before picking", () => {
		const unsorted: ThresholdEntry[] = [
			{ maxTokens: 50_000, color: "green" },
			{ maxTokens: 10_000, color: "orange" },
			{ maxTokens: null, color: "red" },
		];
		assert.strictEqual(pickThreshold(5_000, unsorted).color, "orange");
		assert.strictEqual(pickThreshold(15_000, unsorted).color, "green");
		assert.strictEqual(pickThreshold(100_000, unsorted).color, "red");
	});
});

// ---------------------------------------------------------------------------
// Config loading tests
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	it("returns defaults when key is absent", () => {
		const result = loadConfig({ supervisor: {} });
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.showTimer, true);
		assert.strictEqual(result.config!.showTps, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
	});

	it("returns defaults when settings is null", () => {
		const result = loadConfig(null);
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.showTimer, true);
		assert.strictEqual(result.config!.showTps, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
	});

	it("returns defaults when settings is empty object", () => {
		const result = loadConfig({});
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.showTimer, true);
		assert.strictEqual(result.config!.showTps, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
	});

	it("loads valid config with thresholds", () => {
		const result = loadConfig({
			contextStatusBar: {
				thresholds: [
					{ maxTokens: 50_000, color: "green" },
					{ maxTokens: null, color: "red" },
				],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.showTimer, true);
		assert.strictEqual(result.config!.showTps, true);
		assert.strictEqual(result.config!.thresholds.length, 2);
	});

	it("respects enabled: false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.strictEqual(result.config, null);
	});

	// ── showTimer config tests ─────────────────────────────────

	it("showTimer defaults to true when key absent", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, true);
	});

	it("showTimer: true → showTimer true", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTimer: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, true);
	});

	it("showTimer: false → showTimer false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTimer: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, false);
	});

	it("falls back to defaults when thresholds missing", () => {
		const result = loadConfig({ contextStatusBar: { enabled: true } });
		assert.ok(result.config);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
		assert.ok(result.warnings.length > 0);
	});

	it("falls back to defaults when thresholds is empty array", () => {
		const result = loadConfig({ contextStatusBar: { thresholds: [] } });
		assert.ok(result.config);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
		assert.ok(result.warnings.length > 0);
	});

	it("falls back when contextStatusBar is not an object", () => {
		const result = loadConfig({ contextStatusBar: "not-an-object" });
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
		assert.ok(result.warnings.length > 0);
	});

	it("skips invalid threshold entries", () => {
		const result = loadConfig({
			contextStatusBar: {
				thresholds: [
					{ maxTokens: "bad", color: "green" },
					{ maxTokens: 50_000, color: "" },
					{ maxTokens: 100_000, color: "green" },
				],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.thresholds.length, 1);
		assert.strictEqual(result.config!.thresholds[0]!.maxTokens, 100_000);
	});

	it("allows null maxTokens for catch-all", () => {
		const result = loadConfig({
			contextStatusBar: {
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.thresholds[0]!.maxTokens, null);
	});
});

// ---------------------------------------------------------------------------
// thinkingIcon tests
// ---------------------------------------------------------------------------

describe("thinkingIcon", () => {
	it("returns correct icons for each level", () => {
		assert.strictEqual(thinkingIcon("off"), "○");
		assert.strictEqual(thinkingIcon("minimal"), "◐");
		assert.strictEqual(thinkingIcon("low"), "◑");
		assert.strictEqual(thinkingIcon("medium"), "◒");
		assert.strictEqual(thinkingIcon("high"), "◓");
		assert.strictEqual(thinkingIcon("xhigh"), "●");
	});

	it("returns default for unknown/undefined", () => {
		assert.strictEqual(thinkingIcon(undefined), "·");
		assert.strictEqual(thinkingIcon("unknown"), "·");
	});
});

// ---------------------------------------------------------------------------
// thinkingColor tests
// ---------------------------------------------------------------------------

describe("thinkingColor", () => {
	it("returns correct theme colors for each level", () => {
		assert.strictEqual(thinkingColor("off"), "dim");
		assert.strictEqual(thinkingColor("minimal"), "dim");
		assert.strictEqual(thinkingColor("low"), "muted");
		assert.strictEqual(thinkingColor("medium"), "accent");
		assert.strictEqual(thinkingColor("high"), "warning");
		assert.strictEqual(thinkingColor("xhigh"), "error");
	});

	it("returns dim for unknown/undefined", () => {
		assert.strictEqual(thinkingColor(undefined), "dim");
		assert.strictEqual(thinkingColor("unknown"), "dim");
	});
});

// ---------------------------------------------------------------------------
// getWorktreeName tests
// ---------------------------------------------------------------------------

describe("getWorktreeName", () => {
	it("returns null when .git does not exist", () => {
		const dir = join(tmpdir(), `pi-test-no-git-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		try {
			assert.strictEqual(getWorktreeName(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null for regular git repo (.git is directory)", () => {
		const dir = join(tmpdir(), `pi-test-regular-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		// Create .git as a directory (regular repo)
		mkdirSync(join(dir, ".git"));
		try {
			assert.strictEqual(getWorktreeName(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detects worktree name from .git file", () => {
		const dir = join(tmpdir(), `pi-test-worktree-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".git"), "gitdir: /home/user/.git/worktrees/my-feature-branch\n");
		try {
			assert.strictEqual(getWorktreeName(dir), "my-feature-branch");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns 'worktree' for unknown worktree path format", () => {
		const dir = join(tmpdir(), `pi-test-bad-worktree-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".git"), "gitdir: /some/weird/path\n");
		try {
			assert.strictEqual(getWorktreeName(dir), "worktree");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// TPS config tests
// ---------------------------------------------------------------------------

describe("loadConfig — showTps", () => {
	it("showTps defaults to true when key absent", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTps, true);
	});

	it("showTps: true → showTps true", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTps: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTps, true);
	});

	it("showTps: false → showTps false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTps: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTps, false);
	});

	it("showTps false with showTimer false → both false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTimer: false,
				showTps: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, false);
		assert.strictEqual(result.config!.showTps, false);
	});
});

// ---------------------------------------------------------------------------
// computeTps tests
// ---------------------------------------------------------------------------

describe("computeTps", () => {
	it("empty buffer → null", () => {
		assert.strictEqual(computeTps([]), null);
	});

	it("single sample → null", () => {
		assert.strictEqual(computeTps([{ time: Date.now(), cumulativeTokens: 100 }]), null);
	});

	it("two samples with positive delta → tps", () => {
		const now = Date.now();
		const samples: TpsSample[] = [
			{ time: now - 10_000, cumulativeTokens: 0 },
			{ time: now, cumulativeTokens: 500 },
		];
		// 500 tokens in 10s = 50 t/s
		const tps = computeTps(samples);
		assert.ok(tps !== null);
		assert.strictEqual(tps, 50);
	});

	it("samples outside 30s window are pruned", () => {
		const now = Date.now();
		// Old sample 60s ago — outside 30s window
		const samples: TpsSample[] = [
			{ time: now - 60_000, cumulativeTokens: 0 },
			{ time: now - 5_000, cumulativeTokens: 0 },
			{ time: now, cumulativeTokens: 300 },
		];
		const tps = computeTps(samples);
		assert.ok(tps !== null);
		// After pruning old 60s sample: 300 tokens in 5s = 60 t/s
		assert.strictEqual(tps, 60);
	});

	it("zero token delta → null", () => {
		const now = Date.now();
		const samples: TpsSample[] = [
			{ time: now - 10_000, cumulativeTokens: 100 },
			{ time: now, cumulativeTokens: 100 },
		];
		assert.strictEqual(computeTps(samples), null);
	});

	it("zero time delta → null", () => {
		const now = Date.now();
		const samples: TpsSample[] = [
			{ time: now, cumulativeTokens: 0 },
			{ time: now, cumulativeTokens: 100 },
		];
		assert.strictEqual(computeTps(samples), null);
	});

	it("all samples older than 30s → null", () => {
		const now = Date.now();
		const samples: TpsSample[] = [
			{ time: now - 60_000, cumulativeTokens: 0 },
			{ time: now - 45_000, cumulativeTokens: 500 },
		];
		assert.strictEqual(computeTps(samples), null);
	});
});

// ---------------------------------------------------------------------------
// formatTps tests
// ---------------------------------------------------------------------------

describe("formatTps", () => {
	it("null → -- t/s", () => {
		assert.strictEqual(formatTps(null), "-- t/s");
	});

	it("42.5 → 42.5 t/s", () => {
		assert.strictEqual(formatTps(42.5), "42.5 t/s");
	});

	it("0 → 0.0 t/s", () => {
		assert.strictEqual(formatTps(0), "0.0 t/s");
	});

	it("0.05 → 0.0 t/s (very slow)", () => {
		assert.strictEqual(formatTps(0.05), "0.0 t/s");
	});

	it("0.1 → 0.1 t/s", () => {
		assert.strictEqual(formatTps(0.1), "0.1 t/s");
	});

	it("999.9 → 999.9 t/s", () => {
		assert.strictEqual(formatTps(999.9), "999.9 t/s");
	});

	it("1000 → 1000 t/s (integer, no decimal)", () => {
		assert.strictEqual(formatTps(1000), "1000 t/s");
	});

	it("1234.5 → 1235 t/s (rounded integer)", () => {
		assert.strictEqual(formatTps(1234.5), "1235 t/s");
	});
});

// ---------------------------------------------------------------------------
// formatCacheStats tests
// ---------------------------------------------------------------------------

function formatCacheStats(
	cacheRead: number | undefined | null,
	cacheWrite: number | undefined | null,
): string {
	if (
		cacheRead === undefined ||
		cacheRead === null ||
		cacheWrite === undefined ||
		cacheWrite === null
	) {
		return "\u{1F4E6} --/--";
	}
	return `\u{1F4E6} ${_fmtTokens(cacheRead)}/${_fmtTokens(cacheWrite)}`;
}

function _fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

describe("formatCacheStats", () => {
	it("formatCacheStats(76288, 0) → 📦 76.3K/0 using formatTokens for each value", () => {
		assert.strictEqual(formatCacheStats(76288, 0), "\u{1F4E6} 76.3K/0");
	});

	it("formatCacheStats(1200000, 500) → 📦 1.2M/500 (mixed suffix and plain)", () => {
		assert.strictEqual(formatCacheStats(1200000, 500), "\u{1F4E6} 1.2M/500");
	});

	it("formatCacheStats(0, 0) → 📦 0/0 (valid data, not placeholder)", () => {
		assert.strictEqual(formatCacheStats(0, 0), "\u{1F4E6} 0/0");
	});

	it("formatCacheStats(undefined, undefined) → 📦 --/-- (no data yet)", () => {
		assert.strictEqual(formatCacheStats(undefined, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(null, undefined) → 📦 --/-- (null treated as unavailable)", () => {
		assert.strictEqual(formatCacheStats(null, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(0, undefined) → 📦 --/-- (partial data treated as unavailable)", () => {
		assert.strictEqual(formatCacheStats(0, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(undefined, 0) → 📦 --/-- (partial data treated as unavailable)", () => {
		assert.strictEqual(formatCacheStats(undefined, 0), "\u{1F4E6} --/--");
	});
});

// ---------------------------------------------------------------------------
// showCache config tests
// ---------------------------------------------------------------------------

describe("loadConfig — showCache", () => {
	it("showCache defaults to true when key absent", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showCache, true);
	});

	it("showCache: true → showCache true", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showCache: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showCache, true);
	});

	it("showCache: false → showCache false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showCache: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showCache, false);
	});

	it("showCache: invalid (non-boolean) → emits warning, defaults to true", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showCache: "yes",
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showCache, true);
		assert.ok(result.warnings.some((w) => w.includes("showCache")));
	});

	it("showCache false with showTimer false and showTps false → all three false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTimer: false,
				showTps: false,
				showCache: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, false);
		assert.strictEqual(result.config!.showTps, false);
		assert.strictEqual(result.config!.showCache, false);
	});
});
