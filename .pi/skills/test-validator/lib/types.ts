// Domain types shared by the test-validator skill. Pure data: no fs, no
// network, so every layer can depend on them without pulling in an adapter.

/** One runnable `node:test` call site. Identity = file + line range + name. */
export interface TestDefinition {
	/** Repository-relative path, echoed verbatim by the discovery step. */
	readonly file: string;
	/** Describe chain + title (`outer > inner > title`). */
	readonly name: string;
	/** 1-based inclusive first line of the call site. */
	readonly startLine: number;
	/** 1-based inclusive last line of the call site. */
	readonly endLine: number;
	/** sha256 of the exact `startLine..endLine` slice of the file. */
	readonly sourceSha256: string;
}

/** Why a call site never runs: `it.skip`/`{skip:true}` or `it.todo`. */
type ExclusionReason = "skip" | "todo";

/** A discovered call site that the runner does not execute. */
export interface ExcludedDefinition extends TestDefinition {
	readonly reason: ExclusionReason;
}

/** The pure result of scanning one file. */
export interface InventoryResult {
	readonly tests: readonly TestDefinition[];
	readonly excluded: readonly ExcludedDefinition[];
}

/** The verdict a decision model is allowed to produce. */
export type VerdictDecision = "GOOD" | "BAD" | "PENDING";

/** One quoted line of the decision model's evidence. */
export interface VerdictEvidence {
	readonly line: number;
	readonly quote: string;
}

/** A judged test. `PENDING` means "not decided yet", never "probably bad". */
export interface Verdict {
	readonly decision: VerdictDecision;
	readonly confidence: number;
	readonly criteria: readonly string[];
	readonly reason: string;
	readonly evidence: readonly VerdictEvidence[];
	/** Why the parser withheld a decision; empty for GOOD/BAD. */
	readonly pendingReason: string;
}

/** Skill configuration (`config.json`). */
export interface ValidatorConfig {
	readonly provider: string;
	readonly model: string;
	readonly concurrency: number;
	readonly badConfidenceThreshold: number;
	readonly maxAttempts: number;
	readonly haltAfterConsecutiveFailures: number;
}

/** A test handed to the decision model: the slice plus its surrounding context. */
export interface DecisionRequest {
	readonly file: string;
	readonly name: string;
	readonly startLine: number;
	readonly endLine: number;
	/** Describe chain above the call site, empty at top level. */
	readonly header: string;
	/** Top-level `import` statements of the file. */
	readonly imports: string;
	/** Exact source text of `startLine..endLine`. */
	readonly slice: string;
}

/** Stable key used by the checkpoint, the report, and the run coordinator. */
export function testKey(def: {
	file: string;
	name: string;
	startLine: number;
	endLine: number;
}): string {
	return `${def.file}:${def.startLine}-${def.endLine}:${def.name}`;
}
