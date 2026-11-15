// Use case: file the single cleanup issue, never twice.
//
// The order matters. An `issue-intent` record is written *before* the create
// call, so a crash between the two leaves a searchable marker instead of a
// duplicate issue. On resume with an intent but no URL the filer searches by the
// run marker; a search that finds nothing means the create never happened, and a
// search that fails halts — it never guesses.

import type { CheckpointStore, IssueFiler, IssueRecord } from "./ports.ts";
import type { RunReport } from "./report.ts";
import { renderIssueBody } from "./report.ts";

/** What filing needs from the run's dependencies. */
interface FilingDeps {
	readonly checkpoint: CheckpointStore;
	readonly filer: IssueFiler;
}

interface FilingInput {
	readonly runFingerprint: string;
	readonly draft: RunReport;
	/** The issue this checkpoint already recorded, if any. */
	readonly priorIssue: IssueRecord | null;
	/** True when a previous attempt recorded an intent. */
	readonly hadIntent: boolean;
}

/**
 * Create the cleanup issue, or recover the one a previous attempt created.
 *
 * @returns the issue record, or null when no test is BAD (nothing to file)
 */
export async function fileCleanupIssue(
	deps: FilingDeps,
	input: FilingInput,
): Promise<IssueRecord | null> {
	if (input.priorIssue !== null) return input.priorIssue;

	const badTests = input.draft.tests.filter((entry) => entry.decision === "BAD");
	const rendered = renderIssueBody({
		runFingerprint: input.runFingerprint,
		badTests,
		counts: input.draft.counts,
	});
	if (rendered === null) return null;

	if (input.hadIntent) {
		const found = await deps.filer.search({ runFingerprint: input.runFingerprint });
		if (found !== null) {
			await deps.checkpoint.recordIssue(found);
			return found;
		}
	}

	await deps.checkpoint.recordIssueIntent({
		runFingerprint: input.runFingerprint,
		title: rendered.title,
	});
	const created = await deps.filer.create(rendered);
	const issue = { runFingerprint: input.runFingerprint, url: created.url };
	await deps.checkpoint.recordIssue(issue);
	return issue;
}
