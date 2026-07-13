// ─── Issue Comment Operations ─────────────────────────────────────
// postIssueComment only — the parser functions (extractAgentCommentBody,
// extractStructuredAuditOutput, filterIssueData) have moved to
// agent/output.ts and lib/issue-filter.ts respectively.

import { writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join as joinPath } from "node:path";
import type { ExecFn } from "../pipeline/helpers.ts";
import { gh } from "./gh-client.ts";
import { normalizeEscapes } from "../agent/output.ts";
import { getDebugLogger } from "../lib/debug.ts";

// ─── Post Issue Comment ───────────────────────────────────────────

/**
 * Hard safety limit for GitHub comment body length.
 * Prevents agent execution logs (fullLog with tool calls, thinking,
 * results) from being posted as issue comments if upstream extraction
 * or builder logic has a bug.
 *
 * This is a defense-in-depth cap (50KB) that only catches pathological
 * full-log dumps while allowing legitimate long comments through.
 */
const MAX_COMMENT_CHARS = 50_000;

export async function postIssueComment(
	exec: ExecFn,
	issueNum: number,
	repo: string,
	body: string,
): Promise<void> {
	const log = getDebugLogger();
	// Normalize escaped newlines as final safety net.
	// Catches literal \\n sequences from any extraction path (JSON parsing,
	// heading fallback, COMMENT_BODY marker, audit output fallback).
	const normalized = normalizeEscapes(body);
	// Truncate as defense-in-depth against full-log dumps.
	// Full agent logs are typically 100K+ chars; legitimate comments are
	// under 10K chars. If body exceeds the hard limit, it's almost certainly
	// a bug — truncate and append overflow notice instead of posting raw log.
	const truncated =
		normalized.length > MAX_COMMENT_CHARS
			? normalized.slice(0, MAX_COMMENT_CHARS) +
				"\n\n---\n⚠️ **Comment truncated at 50,000 character safety limit** — a bug likely caused the full agent execution log to be included. Please report this."
			: normalized;
	const preview = truncated.slice(0, 200).replace(/\n/g, " ");
	log.info("comment", `Posting comment on #${issueNum} (${repo})`, {
		issueNum,
		repo,
		bodyLen: normalized.length,
		truncated: normalized.length > MAX_COMMENT_CHARS,
		preview,
	});

	// Write body to temp file to avoid shell interpreting special characters.
	// Per AGENTS.md: save to ignore/ folder, delete after use.
	const tempFile = joinPath("ignore", `comment-body-${issueNum}-${Date.now()}.md`);
	try {
		await mkdir(dirname(tempFile), { recursive: true });
		await writeFile(tempFile, truncated, "utf-8");
	} catch (writeErr: unknown) {
		const writeMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
		log.error("comment", `Failed to write comment body temp file: ${writeMsg}`);
		throw new Error(`Failed to write comment body temp file: ${writeMsg}`);
	}

	try {
		await gh(exec, ["issue", "comment", String(issueNum), "--repo", repo, "--body-file", tempFile]);
		log.info("comment", `Comment posted on #${issueNum}`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error("comment", `Failed to post comment on #${issueNum}`, {
			error: msg,
			issueNum,
			repo,
		});
		throw err;
	} finally {
		// Clean up temp file
		try {
			await unlink(tempFile);
			log.debug("comment", `Temp file deleted: ${tempFile}`);
		} catch (cleanupErr: unknown) {
			const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
			log.warn("comment", `Failed to delete temp file ${tempFile}: ${cleanupMsg}`);
		}
	}
}
