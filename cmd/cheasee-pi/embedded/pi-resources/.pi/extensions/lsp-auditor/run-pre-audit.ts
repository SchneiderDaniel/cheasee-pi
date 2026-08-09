/**
 * Orchestrator for LSP pre-audit.
 *
 * Git diff → file grouping → audit per group → merge → retry decision.
 * Calls Pi API (ctx.sessionManager, pi.sendUserMessage, pi.appendEntry).
 * Outermost application layer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve as resolvePath } from "node:path";
import type { PreAuditOptions, PreAuditResult, LspDiagnostic, AuditResult } from "./types.ts";
import { formatDiagnostics } from "./formatting.ts";
import { buildServerMappings } from "./server-mappings.ts";
import { extractModifiedFiles, groupFilesByServer } from "./file-discovery.ts";
import { countRetryAttempts, shouldRetry, MAX_RETRIES, RETRY_ENTRY_TYPE } from "./retry.ts";
import { auditFileGroup } from "./lsp-client.ts";
import { readSettings } from "./settings.ts";

// ─── Project Trust Helper ────────────────────────────────────────────

/**
 * Check if the current project is trusted by the user.
 *
 * If the project is not trusted, LSP audit should be skipped because
 * LSP servers may execute arbitrary code from workspace configuration.
 * This matches the VS Code Restricted Mode precedent.
 *
 * Returns { trusted: true } if trusted, or { trusted: false, note: string }
 * explaining why the audit was skipped.
 *
 * Defensive: returns untrusted + note if ctx is null/undefined or
 * isProjectTrusted throws (fail-closed).
 */
export function checkProjectTrust(
	ctx: { isProjectTrusted: () => boolean } | null | undefined,
): { trusted: true } | { trusted: false; note: string } {
	if (!ctx || typeof ctx.isProjectTrusted !== "function") {
		return {
			trusted: false,
			note: "LSP audit skipped: project trust status unavailable (context missing)",
		};
	}

	try {
		if (ctx.isProjectTrusted()) {
			return { trusted: true };
		}
		return {
			trusted: false,
			note:
				"LSP audit skipped: project not trusted. LSP servers can execute " +
				"code from workspace configuration. Trust the project with " +
				'`pi trust` or `defaultProjectTrust: "always"` in settings to enable.',
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			trusted: false,
			note: `LSP audit skipped: project trust check failed (${msg})`,
		};
	}
}

/**
 * Map session-storage entries to retry-logic shape.
 *
 * Session entries from `appendEntry()` have shape:
 *   { type: "custom", customType: "<type>", data: <payload> }
 * Retry logic expects:  { type: "<type>", payload: <payload> }
 *
 * Non-custom entries pass through with full entry as payload.
 */
export function mapSessionEntriesToRetryEntries(
	entries: Array<Record<string, unknown>>,
): Array<{ type: string; payload: unknown }> {
	return entries.map((e) => {
		if (e.type === "custom") {
			return { type: (e.customType as string) ?? "", payload: e.data };
		}
		return { type: e.type as string, payload: e };
	});
}

/**
 * Run pre-audit LSP diagnostics on modified files.
 *
 * Called by supervisor before transitioning Implementation → Audit.
 * Returns { proceed: true } if audit passes (no errors) or retries exhausted.
 * Returns { proceed: false } if errors found and retries remain (Developer should fix).
 */
export async function runPreAudit(
	options: PreAuditOptions,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<PreAuditResult> {
	const { issueNum, worktreePath, defaultBranch } = options;

	// 0. Check project trust before any LSP server interaction
	const trustCheck = checkProjectTrust(ctx);
	if (!trustCheck.trusted) {
		pi.sendUserMessage?.(trustCheck.note, { deliverAs: "followUp" });
		return { proceed: true, note: trustCheck.note };
	}

	// 1. Get modified files via git diff
	let gitOutput: string;
	try {
		const { execFile } = await import("node:child_process");
		const worktreeAbs = resolvePath(worktreePath);
		gitOutput = await new Promise<string>((resolve, reject) => {
			execFile(
				"git",
				["diff", defaultBranch, "--name-only"],
				{
					cwd: worktreeAbs,
					encoding: "utf-8",
					timeout: 10_000,
				},
				(err, stdout) => {
					if (err) reject(err);
					else resolve(stdout.trim());
				},
			);
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? (err as any).stderr?.toString() || err.message : String(err);
		pi.sendUserMessage?.(`LSP audit skipped: git diff failed (${msg})`, { deliverAs: "followUp" });
		return { proceed: true, note: `LSP audit skipped: git diff failed` };
	}

	const modifiedFiles = extractModifiedFiles(gitOutput, resolvePath(worktreePath));

	// AC3: No modified files → skip
	if (modifiedFiles.length === 0) {
		return { proceed: true, note: "LSP audit skipped: no modified files in Developer session" };
	}

	// 2. Load server mappings from settings (resolved relative to worktree)
	const settings = readSettings(resolvePath(worktreePath));
	const mappings = buildServerMappings(settings?.lspAuditor);

	// 3. Group files by server
	const { serverFiles, errors: groupingErrors } = groupFilesByServer(modifiedFiles, mappings);

	// 4. Audit each server group
	const results: AuditResult[] = [];
	for (const [mapping, files] of serverFiles) {
		if (files.length === 0) continue;

		const result = await auditFileGroup(mapping, files, resolvePath(worktreePath));
		results.push(result);
	}

	// Add unsupported note from grouping
	if (groupingErrors.length > 0) {
		results.push({ diagnostics: [], errors: groupingErrors, note: "" });
	}

	const merged = mergeAuditResults(results);

	// If all LSP servers failed (no diagnostics collected, only errors)
	const hasServerErrors = merged.errors.length > 0;
	const hasNoDiagnostics = merged.diagnostics.length === 0;

	if (hasServerErrors && hasNoDiagnostics) {
		// All servers failed — skip audit, proceed with warning
		const note = `LSP audit skipped: all configured servers failed — ${merged.errors.join("; ")}`;
		return { proceed: true, note };
	}

	// 5. Diagnostics already filtered per-server by auditFileGroup (R3 AC3).
	const filteredDiags: LspDiagnostic[] = merged.diagnostics;

	if (filteredDiags.length === 0) {
		// AC4: Zero errors/warnings → proceed to Audit with success note
		let note = "LSP audit: ✓ no errors or warnings detected";
		if (merged.errors.length > 0) {
			note += ` (server warnings: ${merged.errors.join("; ")})`;
		}
		return { proceed: true, note };
	}

	// 6. Check retry count
	const sessionManager = ctx.sessionManager;
	const entries = mapSessionEntriesToRetryEntries(
		sessionManager.getEntries() as unknown as Array<Record<string, unknown>>,
	);
	const retryCount = countRetryAttempts(entries, issueNum);

	if (!shouldRetry(retryCount)) {
		// AC2: Retries exhausted → proceed to Audit with errors documented
		const formatted = formatDiagnostics(filteredDiags);
		const note = `LSP audit exhausted (${retryCount}/${MAX_RETRIES} retries). Remaining issues:\n${formatted}`;
		return { proceed: true, note };
	}

	// R2: Inject follow-up message to Developer, keep in Implementation
	const formatted = formatDiagnostics(filteredDiags);
	const attemptNum = retryCount + 1;
	const followUpMsg = [
		`## LSP Audit — Pre-Review Diagnostics (attempt ${attemptNum}/${MAX_RETRIES})`,
		``,
		`The following diagnostics were detected in your changes. Please fix them before the human Auditor reviews.`,
		``,
		formatted,
		merged.errors.length > 0 ? `\nServer notes: ${merged.errors.join("; ")}` : "",
	].join("\n");

	pi.sendUserMessage?.(followUpMsg, { deliverAs: "followUp" });

	// Record retry attempt
	pi.appendEntry?.(RETRY_ENTRY_TYPE, {
		issueNum,
		attempt: attemptNum,
		timestamp: new Date().toISOString(),
	});

	return {
		proceed: false,
		note: `LSP audit: ${filteredDiags.length} issue(s) found — retry ${attemptNum}/${MAX_RETRIES}`,
	};
}

/**
 * Merge multiple audit results (one per LSP server) into a single result.
 * Local helper to avoid circular import with formatting.ts.
 */
export function mergeAuditResults(results: AuditResult[]): AuditResult {
	const allDiags: LspDiagnostic[] = [];
	const allErrors: string[] = [];

	for (const r of results) {
		if (r.diagnostics) allDiags.push(...r.diagnostics);
		if (r.errors) allErrors.push(...r.errors);
	}

	let note = "";
	if (allErrors.length > 0) {
		note = `Warnings: ${allErrors.join("; ")}`;
	}

	return { diagnostics: allDiags, errors: allErrors, note };
}
