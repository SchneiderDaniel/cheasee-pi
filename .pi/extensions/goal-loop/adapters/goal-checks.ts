// ─── Harness verification runner ────────────────────────────────
// Executes a criterion's verifier from the harness side, never from the agent's
// claim. Command verifiers run as an argv array (never a shell string) in the
// goal worktree after every pinned hash is re-verified, so a fix that rewrites
// the check script cannot pass. Inspect verifiers receive harness-produced
// evidence only: the record's stored evidence never counts.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { failure, type Result } from "../../shared/result.ts";
import type { ExecLike } from "../../shared/git/git-exec.ts";
import type { AcceptanceCriterion, PinnedFile } from "../domain/goal-record.ts";
import type { CheckOutcome, CheckRunner } from "../application/ports.ts";

const CHECK_SOURCE = "goal-check";

/** Verdict from a nested inspect call. */
export interface InspectVerdict {
	pass: boolean;
	/** Short justification quoted into the record's evidence. */
	note: string;
}

/** Runs an `inspect` verifier over harness-produced evidence. */
export type InspectRunner = (instruction: string, evidence: string) => Promise<InspectVerdict>;

export interface HarnessCheckRunnerOptions {
	exec: ExecLike;
	/** Nested fresh-context judgement; absent means inspect criteria fail closed. */
	inspect?: InspectRunner;
	/** Read a file's bytes for pinned-hash verification (injectable for tests). */
	readFile?: (path: string) => Buffer;
}

/** SHA-256 hex digest of a file's bytes. */
function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Harness-side {@link CheckRunner}. */
export class HarnessCheckRunner implements CheckRunner {
	private readonly exec: ExecLike;
	private readonly inspect?: InspectRunner;
	private readonly readFile: (path: string) => Buffer;

	constructor(options: HarnessCheckRunnerOptions) {
		this.exec = options.exec;
		this.inspect = options.inspect;
		this.readFile = options.readFile ?? ((path) => readFileSync(path));
	}

	async run(criterion: AcceptanceCriterion, worktree: string): Promise<Result<CheckOutcome>> {
		if (!worktree) {
			return failure(`criterion ${criterion.id} has no worktree to verify against`, CHECK_SOURCE);
		}
		const verifier = criterion.verifier;
		if (verifier.kind === "command") {
			const pinnedFailure = this.checkPinned(verifier.pinned, worktree);
			if (pinnedFailure) {
				return { ok: true, value: { result: "fail", evidenceRef: pinnedFailure } };
			}
			return await this.runCommand(verifier.argv, verifier.expectExit, worktree);
		}
		return await this.runInspect(criterion, verifier.instruction, worktree);
	}

	/** Why a pinned file no longer matches, or null when all match. */
	private checkPinned(pinned: PinnedFile[], worktree: string): string | null {
		for (const file of pinned) {
			const absolute = isAbsolute(file.path) ? file.path : join(worktree, file.path);
			let bytes: Buffer;
			try {
				bytes = this.readFile(absolute);
			} catch {
				return `pinned file ${file.path} is missing — verifier not executed`;
			}
			const actual = sha256(bytes);
			if (actual !== file.sha256) {
				return `pinned hash mismatch for ${file.path} (expected ${file.sha256.slice(0, 12)}, got ${actual.slice(0, 12)}) — verifier not executed`;
			}
		}
		return null;
	}

	private async runCommand(
		argv: string[],
		expectExit: number,
		worktree: string,
	): Promise<Result<CheckOutcome>> {
		const [command, ...args] = argv;
		if (!command) return failure("command verifier has an empty argv", CHECK_SOURCE);
		let result;
		try {
			result = await this.exec(command, args, { cwd: worktree, timeout: 600_000 });
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			return failure(`cannot execute ${argv.join(" ")}: ${reason}`, CHECK_SOURCE);
		}
		const passed = result.code === expectExit;
		return {
			ok: true,
			value: {
				result: passed ? "pass" : "fail",
				evidenceRef: `\`${argv.join(" ")}\` exited ${result.code} (expected ${expectExit})`,
			},
		};
	}

	private async runInspect(
		criterion: AcceptanceCriterion,
		instruction: string,
		worktree: string,
	): Promise<Result<CheckOutcome>> {
		if (!this.inspect) {
			return failure(
				`criterion ${criterion.id} needs an inspect verifier but none is configured`,
				CHECK_SOURCE,
			);
		}
		const evidence = await this.collectEvidence(worktree);
		if (!evidence.ok) return evidence;
		let verdict: InspectVerdict;
		try {
			verdict = await this.inspect(instruction, evidence.value);
		} catch (err: unknown) {
			const reason = err instanceof Error ? err.message : String(err);
			return failure(`inspect verifier for ${criterion.id} failed: ${reason}`, CHECK_SOURCE);
		}
		return {
			ok: true,
			value: {
				result: verdict.pass ? "pass" : "fail",
				evidenceRef: `inspect: ${verdict.note}`,
			},
		};
	}

	/** Harness-produced evidence: the worktree diff and status, never the record. */
	private async collectEvidence(worktree: string): Promise<Result<string>> {
		const status = await this.exec("git", ["status", "--porcelain"], {
			cwd: worktree,
			timeout: 60_000,
		});
		if (status.code !== 0) {
			return failure(`cannot read the goal worktree status: ${status.stderr}`, CHECK_SOURCE);
		}
		const diff = await this.exec("git", ["diff", "HEAD"], { cwd: worktree, timeout: 120_000 });
		if (diff.code !== 0) {
			return failure(`cannot read the goal worktree diff: ${diff.stderr}`, CHECK_SOURCE);
		}
		return {
			ok: true,
			value: `## git status --porcelain\n${status.stdout}\n## git diff HEAD\n${diff.stdout}`,
		};
	}
}
