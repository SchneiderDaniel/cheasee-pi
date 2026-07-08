/**
 * thinking-level.ts — Canonical thinking-level → icon/color/label mappings.
 *
 * Domain layer — zero dependencies (no pi runtime, no agent-harness).
 * Pure functions with no I/O.
 *
 * Single source of truth for all extensions. Three public functions
 * read from one internal TABLE — drift is structurally impossible.
 */

// ── Types ──

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

// ── Internal table ──

interface LevelEntry {
	icon: string;
	color: string;
}

const TABLE: Record<string, LevelEntry> = {
	off: { icon: "○", color: "dim" },
	minimal: { icon: "◐", color: "dim" },
	low: { icon: "◑", color: "muted" },
	medium: { icon: "◒", color: "accent" },
	high: { icon: "◓", color: "warning" },
	xhigh: { icon: "●", color: "error" },
};

// ── Public API ──

/** Map thinking level to its unicode icon character. Falls back to "·". */
export function thinkingIcon(level: string | undefined): string {
	if (!level) return "\u00b7";
	return TABLE[level]?.icon ?? "\u00b7";
}

/** Map thinking level to a TUI theme color name. Falls back to "dim". */
export function thinkingColor(level: string | undefined): string {
	if (!level) return "dim";
	return TABLE[level]?.color ?? "dim";
}

/**
 * Format thinking level as "◒ medium" or empty string if not set.
 * Returns empty string for falsy/empty/unknown levels (consumers gate on truthiness).
 */
export function thinkingLabel(level: string | undefined): string {
	if (!level) return "";
	const icon = thinkingIcon(level);
	if (icon === "\u00b7") return "";
	return `${icon} ${level}`;
}
