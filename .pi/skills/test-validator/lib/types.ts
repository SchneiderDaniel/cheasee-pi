// Domain types shared by the test-validator skill. Pure data: no fs, no
// network, so every layer can depend on them without pulling in an adapter.

/**
 * The kind of test file a definition came from. Discovery is language-aware so
 * a repository-wide audit is not silently limited to one runner.
 */
export type TestLanguage = "typescript" | "go" | "python" | "shell" | "rust";

/** Every language the inventory can enumerate. */
export const TEST_LANGUAGES: readonly TestLanguage[] = [
	"typescript",
	"go",
	"python",
	"shell",
	"rust",
];

/**
 * One runnable test unit. Identity = file + line range + name.
 *
 * The unit is a call site where the language allows static enumeration
 * (`it(...)`, `func TestX`, `def test_x`, `#[test] fn`) and the whole file where
 * it does not (a shell test script, a script-style Python test module).
 */
export interface TestDefinition {
	/** Repository-relative path, echoed verbatim by the discovery step. */
	readonly file: string;
	/** Scope chain + title (`outer > inner > title`). */
	readonly name: string;
	/** Which test-file family the definition came from. */
	readonly language: TestLanguage;
	/** 1-based inclusive first line of the call site. */
	readonly startLine: number;
	/** 1-based inclusive last line of the call site. */
	readonly endLine: number;
	/** sha256 of the exact `startLine..endLine` slice of the file. */
	readonly sourceSha256: string;
}

/**
 * Why a discovered test unit never runs as a test:
 * `it.skip`/`{skip:true}` (`skip`), `it.todo` (`todo`), a Go benchmark that
 * `go test` does not run without `-bench` (`not-run-by-default`), or a Go
 * `_test.go` file that only carries helpers (`test-support-file`).
 */
type ExclusionReason = "skip" | "todo" | "not-run-by-default" | "test-support-file";

/** A discovered test unit that the runner does not execute as a test. */
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
	readonly language: TestLanguage;
	readonly startLine: number;
	readonly endLine: number;
	/** Enclosing scope above the unit (describe chain, class), empty at top level. */
	readonly header: string;
	/** The file's import/preamble block: what the slice depends on. */
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
