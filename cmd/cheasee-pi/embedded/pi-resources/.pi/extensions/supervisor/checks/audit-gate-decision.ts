// ─── Audit Gate Decision ──────────────────────────────────────────
// Unified decision module for audit-gate policies (tsc, lsp).
// Strategy pattern with data policies.
//
// determineAuditGate: sync, pure, shared frame for all audit-gate policies.
// getRunGate: async, performs dynamic import of the runner module.

import { formatDiagnostics } from "../../tsc-checkpoint/format.ts";
import type { TscCheckpointResult } from "../../lib/tsc-types.ts";

// ── Types ──

export interface AuditGateDecision {
	nextStatus: string;
	note: string;
	triggered: boolean;
}

export type PolicyName = "tsc" | "lsp";

export interface PolicyContext {
	hasModifiedFiles?: boolean;
	retryCount?: number;
	[key: string]: unknown;
}

interface PolicyEntry {
	runnerModule: string;
	runnerFn: string;
	shouldSkip: (ctx: PolicyContext) => boolean;
	getSkipNote: (ctx: PolicyContext) => string;
	nullResultNote: string;
	evaluate: (result: unknown, ctx: PolicyContext) => AuditGateDecision;
}

// ── Retry Count Normalization ──

function normalizeRetryCount(raw: unknown): number {
	if (typeof raw !== "number" || Number.isNaN(raw) || raw < 0) return 0;
	return raw;
}

// ── Policy Registry ──

const POLICIES: Record<string, PolicyEntry> = {
	tsc: {
		runnerModule: "../../tsc-checkpoint",
		runnerFn: "runTscCheckpoint",
		shouldSkip: () => false,
		getSkipNote: () => "",
		nullResultNote: "TSC checkpoint skipped",
		evaluate: (result: unknown): AuditGateDecision => {
			const r = result as TscCheckpointResult;
			if (r.hasErrors) {
				const formatted = formatDiagnostics(r.diagnostics);
				return {
					nextStatus: "Implementation",
					note: `TSC checkpoint: ${r.diagnostics.length} type error(s) found — fix before proceeding.\n${formatted}`,
					triggered: true,
				};
			}
			return {
				nextStatus: "Audit",
				note: "TSC checkpoint: ✓ no type errors detected",
				triggered: true,
			};
		},
	},
	lsp: {
		runnerModule: "../../lsp-auditor",
		runnerFn: "runPreAudit",
		shouldSkip: (ctx: PolicyContext): boolean => {
			// Skip LSP only when no modified files AND changes are already on main.
			// If no modified files but changes are NOT on main, the work is genuinely
			// missing — LSP should run so it can flag the gap.
			if (ctx.hasModifiedFiles === false && ctx.changeAlreadyOnMain === true) {
				return true;
			}
			return false;
		},
		getSkipNote: (ctx: PolicyContext): string => {
			if (ctx.hasModifiedFiles === false && ctx.changeAlreadyOnMain === true) {
				return "LSP audit skipped: no modified files, changes already on main";
			}
			return "LSP audit skipped: no modified files";
		},
		nullResultNote: "",
		evaluate: (result: unknown, ctx: PolicyContext): AuditGateDecision => {
			const r = result as { proceed: boolean; note: string };
			if (r.proceed) {
				return { nextStatus: "Audit", note: r.note, triggered: true };
			}
			const n = normalizeRetryCount(ctx.retryCount);
			if (n >= 3) {
				return { nextStatus: "Audit", note: r.note, triggered: true };
			}
			return { nextStatus: "Implementation", note: r.note, triggered: true };
		},
	},
};

// ── Public API ──

export interface DetermineAuditGateInput {
	policyName: PolicyName;
	intendedNext: string;
	result: unknown;
	context?: PolicyContext;
}

/**
 * Determine the next pipeline status based on the audit-gate result.
 * Shared frame for all audit-gate policies (tsc, lsp).
 *
 * Pure function — no I/O, no Pi API calls.
 *
 * Flow:
 * 1. If intendedNext !== "Audit" -> passthrough (no gate triggered)
 * 2. If policy.shouldSkip(context) -> Audit with skip note
 * 3. If result is null -> Audit with null-result note
 * 4. Otherwise -> policy.evaluate(result, context)
 */
export function determineAuditGate(input: DetermineAuditGateInput): AuditGateDecision {
	const { policyName, intendedNext, result, context = {} } = input;

	// 1. Passthrough: not transitioning to Audit -> no gate logic
	if (intendedNext !== "Audit") {
		return { nextStatus: intendedNext, note: "", triggered: false };
	}

	const policy = POLICIES[policyName];

	// 2. Policy-specific skip condition (e.g., lsp: no modified files)
	if (policy.shouldSkip(context)) {
		return { nextStatus: "Audit", note: policy.getSkipNote(context), triggered: false };
	}

	// 3. Null result -> not triggered
	if (!result) {
		return { nextStatus: "Audit", note: policy.nullResultNote, triggered: false };
	}

	// 4. Policy-specific evaluation
	return policy.evaluate(result, context);
}

type RunnerMap = {
	tsc: (worktreePath: string) => Promise<TscCheckpointResult>;
	lsp: (
		opts: Record<string, unknown>,
		pi: unknown,
		ctx: unknown,
	) => Promise<{ proceed: boolean; note: string }>;
};

/**
 * Dynamic import of a gate runner function.
 * Type-safe: the return type matches the runner signature for the given policy.
 * Returns null if the policy or runner function is not found.
 */
export async function getRunGate<K extends PolicyName>(name: K): Promise<RunnerMap[K] | null> {
	const policy = POLICIES[name];
	if (!policy) return null;
	const mod: Record<string, unknown> = await import(policy.runnerModule);
	const fn = mod[policy.runnerFn];
	return (fn as RunnerMap[K]) ?? null;
}
