// Domain: fingerprints that decide whether a checkpoint still describes the
// audit that produced it.
//
// `inventoryFingerprint` covers what was judged (identity of every discovered
// test plus the hash of its source slice) and is order-insensitive, so a
// differently ordered scan of the same tree resumes. `configFingerprint` covers
// what judged them (provider, model, BAD threshold, criteria body) and
// deliberately ignores concurrency and retry knobs: changing how many workers
// run must not throw away completed decisions.

import { sha256Hex } from "./inventory.ts";
import type { TestDefinition, ValidatorConfig } from "./types.ts";

/** Identity of a judged file/range/name plus the hash of its source slice. */
function identityLine(def: TestDefinition): string {
	return [def.file, def.startLine, def.endLine, def.name, def.language, def.sourceSha256].join(
		"\t",
	);
}

/**
 * sha256 over the sorted identity lines of every discovered test. A different
 * discovery order, or a duplicate definition, cannot make an unchanged tree
 * look changed; any added, removed, moved, renamed, or edited test does.
 */
export function inventoryFingerprint(definitions: readonly TestDefinition[]): string {
	const lines = definitions.map(identityLine).sort();
	return sha256Hex(["test-validator/inventory/v2", ...lines].join("\n"));
}

/**
 * sha256 over the model identity, the BAD threshold, and the criteria body.
 * `concurrency`, `maxAttempts`, and `haltAfterConsecutiveFailures` are excluded
 * on purpose: they change how a run proceeds, not what a verdict means.
 */
export function configFingerprint(cfg: ValidatorConfig, criteriaSha256: string): string {
	return sha256Hex(
		[
			"test-validator/config/v1",
			cfg.provider,
			cfg.model,
			String(cfg.badConfidenceThreshold),
			criteriaSha256,
		].join("\n"),
	);
}
