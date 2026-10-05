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
 * Threshold escalation keys off explicit declarations. An entirely unannotated
 * object (`{}`) keeps the MCP destructive default and therefore escalates.
 *
 * @packageDocumentation
 */

import {
	DESTRUCTIVE_CASCADE_THRESHOLD,
	OPEN_WORLD_CASCADE_THRESHOLD,
} from "./harness-rules.ts";
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
 */
export function deriveToolMetaFromAnnotations(
	annotations?: ToolAnnotations,
): ToolMeta | undefined {
	if (!annotations) return undefined;

	const hasAnyHint =
		annotations.readOnlyHint !== undefined ||
		annotations.destructiveHint !== undefined ||
		annotations.idempotentHint !== undefined ||
		annotations.openWorldHint !== undefined;

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

	// Escalate the cascade threshold only for explicit destructive/open-world
	// declarations. A fully unannotated object keeps the MCP destructive default.
	const declaresDestructive = annotations.destructiveHint === true || !hasAnyHint;
	if (!readOnly && declaresDestructive) {
		meta.cascadeThreshold = DESTRUCTIVE_CASCADE_THRESHOLD;
	} else if (!readOnly && annotations.openWorldHint === true) {
		meta.cascadeThreshold = OPEN_WORLD_CASCADE_THRESHOLD;
	}

	return meta;
}
