/**
 * tool-annotations.ts — Pure mapping from MCP tool annotations to harness ToolMeta.
 *
 * Pi's `pi.getAllTools()` reports each registered tool's MCP-shaped
 * `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
 * `openWorldHint`). This module derives conservative harness defaults from
 * them — zero pi imports, zero SDK imports.
 *
 * Missing hints are never treated as safe (MCP defaults):
 *   - `destructiveHint ?? true`  → absent means potentially destructive
 *   - `openWorldHint ?? true`    → absent means potentially open-world
 *   - read-only only on `readOnlyHint === true`
 *
 * Threshold derivation keys off *effective classification*, not explicit
 * declarations: a tool is `destructive` unless it is read-only or explicitly
 * non-destructive, and a derived threshold is
 * `min(effectiveThreshold, DESTRUCTIVE_CASCADE_THRESHOLD)` — it may tighten the
 * configured policy but never widen it. `openWorldHint` is a classification
 * flag only; it carries no threshold effect (network egress is a trust-boundary
 * signal, not a volume signal).
 *
 * @packageDocumentation
 */

import { DESTRUCTIVE_CASCADE_THRESHOLD } from "./harness-rules.ts";
import type { ToolMeta } from "./harness-rules.ts";

// ── Types ──

/** MCP tool-annotation hints, mirrored structurally (no SDK dependency). */
export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/** Minimal structural shape of a `pi.getAllTools()` entry this module needs. */
export interface ToolInfoLike {
	name: string;
	annotations?: ToolAnnotations;
}

// ── Helpers ──

/** `hint ?? fallback`, then coerce to a strict boolean (non-boolean hints are not trusted). */
function hintOr(value: boolean | undefined, fallback: boolean): boolean {
	return value === undefined ? fallback : value === true;
}

// ── Derivation ──

/**
 * Derive harness `ToolMeta` defaults from MCP annotations.
 *
 * Returns `undefined` when no annotations object exists — the caller keeps its
 * own conservative default. Annotations are advisory and unverified: explicit
 * config always stays authoritative.
 *
 * @param annotations — MCP-shaped hints (open-shaped; unknown keys ignored)
 * @param effectiveThreshold — the configured cascade threshold; a derived
 *   threshold is `min(effectiveThreshold, DESTRUCTIVE_CASCADE_THRESHOLD)` so a
 *   derived default can never widen past configured policy.
 */
export function deriveToolMetaFromAnnotations(
	annotations: ToolAnnotations | undefined,
	effectiveThreshold: number,
): ToolMeta | undefined {
	if (!annotations) return undefined;

	const readOnly = annotations.readOnlyHint === true;
	const destructive = !readOnly && hintOr(annotations.destructiveHint, true);
	const openWorld = !readOnly && hintOr(annotations.openWorldHint, true);

	const meta: ToolMeta = {
		trackErrors: !readOnly,
		destructive,
		openWorld,
	};

	if (annotations.idempotentHint !== undefined) {
		meta.idempotent = annotations.idempotentHint === true;
	}

	// Destructive classification tightens the cascade threshold, clamped so a
	// derived default can never widen past the configured value.
	if (destructive) {
		meta.cascadeThreshold = Math.min(effectiveThreshold, DESTRUCTIVE_CASCADE_THRESHOLD);
	}

	return meta;
}
