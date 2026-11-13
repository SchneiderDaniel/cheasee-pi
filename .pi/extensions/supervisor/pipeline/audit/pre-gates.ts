// ─── Pipeline Audit: Pre-Gates ────────────────────────────────────
// The six checks that run before the TSC/LSP gates: CI gating,
// duplicate code, dead code, package safety, OSV scan and requirements
// traceability. Each returns { failureText, ...results } so the
// orchestrator aggregates failures in today's push order. Check runners
// are injectable via deps (tests substitute fakes; production uses the
// real implementations).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../../config/types.ts";
import { getDebugLogger } from "../../lib/debug.ts";
import type { ExecFn } from "../../../lib/port-types.ts";
import { pollCiChecks } from "../../checks/ci-gating.ts";
import type { CiPollResult } from "../../checks/ci-gating.ts";
import { runDuplicateCheck } from "../../checks/duplicate-code.ts";
import type { DuplicateCodeResult } from "../../checks/duplicate-code.ts";
import { runDeadCodeCheck, buildDeadCodeContext } from "../../checks/dead-code.ts";
import type { DeadCodeResult } from "../../checks/dead-code.ts";
import {
	runPackageSafetyAudit,
	type PackageSafetyAuditResult,
} from "../../checks/package-safety.ts";
import { runVulnScan, buildVulnContext } from "../../checks/osv-scanner.ts";
import type { OsvScanResult } from "../../checks/osv-scanner.ts";
import { runRequirementsTraceability } from "../../checks/requirements-traceability.ts";

/** Shared environment threaded into every pre-gate. */
export interface PreGateDeps {
	pi: ExtensionAPI;
	execFn: ExecFn;
	ui: ExtensionCommandContext["ui"];
	repo: string;
	branch: string;
	filteredData: { body?: string; comments: Array<{ body: string }> };
	issueTitle: string;
	// Injectable check runners — tests inject fakes; defaults are the real impls.
	pollCiChecksFn?: typeof pollCiChecks;
	runDuplicateCheckFn?: typeof runDuplicateCheck;
	runDeadCodeCheckFn?: typeof runDeadCodeCheck;
	runPackageSafetyAuditFn?: typeof runPackageSafetyAudit;
	runVulnScanFn?: typeof runVulnScan;
	runRequirementsTraceabilityFn?: typeof runRequirementsTraceability;
}

// ── CI Gating ──────────────────────────────────────────────────────

export interface CiGateResult {
	failureText: string | null;
}

/**
 * Read the commit HEAD points at — the commit the gate must evaluate
 * (issue #1829 AC4). Returns `""` when git cannot answer, so the CI gate fails
 * closed instead of classifying an unverified commit. Called only while CI
 * gating is enabled, so a disabled gate adds no git calls.
 */
export async function captureHeadSha(
	exec: ExecFn,
	worktreePath: string,
	ui: ExtensionCommandContext["ui"],
): Promise<string> {
	try {
		const result = await exec("git", ["rev-parse", "HEAD"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		const sha = (result.stdout || "").trim();
		if (result.code === 0 && sha.length > 0) return sha;
		const reason = (result.stderr || "").trim() || `git exited with code ${result.code}`;
		ui.notify(`Cannot resolve the pushed commit SHA: ${reason}`, "warning");
		return "";
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		ui.notify(`Cannot resolve the pushed commit SHA: ${msg}`, "warning");
		return "";
	}
}

/**
 * Step 0: CI gating — poll the open PR's check runs before running local hooks.
 * BLOCKING: `failing`, `pending` (at timeout) and `error` all stop the
 * Implementation → Audit transition. `unconfigured` passes with a warning so
 * repos without CI never hang. Disabled when ciGatingTimeoutSec is unset or ≤ 0.
 *
 * `expectedHeadSha` pins the poll to the commit the developer just pushed
 * (issue #1829): without it the gate cannot tell the pushed commit apart from
 * a stale PR head, so a missing SHA is a blocking failure (fail closed).
 */
export async function runCiGate(
	deps: PreGateDeps,
	config: SupervisorConfig,
	expectedHeadSha: string,
): Promise<CiGateResult> {
	const timeoutSec = config.ciGatingTimeoutSec;
	if (!timeoutSec || timeoutSec <= 0) {
		return { failureText: null };
	}

	// Disabled gating wins over the SHA requirement; with gating on, an absent
	// SHA must never let a red PR reach the auditor.
	if (!expectedHeadSha || expectedHeadSha.trim().length === 0) {
		const message =
			"CI gate requires the expected head SHA (the commit just pushed) but none was captured — refusing to pass CI unverified.";
		deps.ui.notify(`${message} Blocking audit (fail-closed).`, "warning");
		return { failureText: `--- CI Gate ---\n${message}` };
	}

	getDebugLogger().info("pipeline-audit", "Polling PR check runs", {
		branch: deps.branch,
		timeoutSec,
		expectedHeadSha,
	});

	const pollCiChecksFn = deps.pollCiChecksFn ?? pollCiChecks;
	let ciResult: CiPollResult;
	try {
		ciResult = await pollCiChecksFn(deps.pi, deps.branch, deps.repo, timeoutSec, {
			expectedHeadSha,
		});
	} catch (err: unknown) {
		// pollCiChecks reports failures as status "error"; a throw is a defect.
		// Fail closed and surface it instead of letting a red PR reach audit.
		const message = err instanceof Error ? err.message : String(err);
		deps.ui.notify(`CI gate crashed: ${message}. Blocking audit (fail-closed).`, "warning");
		return { failureText: `--- CI Gate ---\nCI gate crashed: ${message}` };
	}

	switch (ciResult.status) {
		case "passing":
			getDebugLogger().info("pipeline-audit", ciResult.message);
			return { failureText: null };

		case "unconfigured":
			// AC4: no CI configured — proceed, but never silently.
			deps.ui.notify(`CI gate: ${ciResult.message}`, "warning");
			return { failureText: null };

		case "failing": {
			const names =
				ciResult.failingChecks.length > 0 ? ciResult.failingChecks.join(", ") : "unknown";
			deps.ui.notify(`CI checks failing: ${names}. Blocking audit until CI is green.`, "warning");
			return { failureText: formatCiFailureText(ciResult) };
		}

		case "pending":
			deps.ui.notify(
				`CI checks still pending after ${timeoutSec}s (ciGatingTimeoutSec). Blocking audit until CI settles.`,
				"warning",
			);
			return { failureText: `--- CI Gate ---\n${ciResult.message}` };

		case "error":
			deps.ui.notify(
				`CI check polling failed: ${ciResult.message} Blocking audit (fail-closed).`,
				"warning",
			);
			return { failureText: `--- CI Gate ---\n${ciResult.message}` };
	}
}

/**
 * Build the CI gate failure section. The failing check names go into the
 * section header (issue #1829) so they survive `extractFirstGateName` into
 * `gateFailureHistory` and the developer/PR surfaces always name the red
 * check. When the poller could not name them the header stays plain and the
 * body says so.
 */
function formatCiFailureText(ciResult: CiPollResult): string {
	const names = ciResult.failingChecks.length > 0 ? ciResult.failingChecks.join(", ") : null;
	const header = names ? `--- CI Gate (failing: ${names}) ---` : "--- CI Gate ---";
	const message = ciResult.message.trim();
	const body = names ? message : `${message} Failing check(s): unknown.`;
	return `${header}\n${body}`;
}

// ── Duplicate Code ─────────────────────────────────────────────────

export interface DuplicateGateResult {
	failureText: null;
	dupResult: DuplicateCodeResult;
}

/**
 * Step 1: Duplicate code detection gate.
 * Non-blocking — duplicates found are surfaced as warning and
 * verified by the auditor agent.
 */
export async function runDuplicateGate(
	deps: PreGateDeps,
	config: SupervisorConfig,
	worktreePath: string,
): Promise<DuplicateGateResult> {
	getDebugLogger().info("pipeline-audit", "Running duplicate code check", { worktreePath });
	const runDuplicateCheckFn = deps.runDuplicateCheckFn ?? runDuplicateCheck;
	const dupResult = await runDuplicateCheckFn(
		deps.execFn,
		worktreePath,
		config.defaultBranch || "main",
	);

	if (dupResult.status === "duplicates_found") {
		deps.ui.notify(
			`Duplicate code detected: ${dupResult.clones.length} clone(s) found (${dupResult.totalDuplicateLines} lines). Auditor will verify.`,
			"warning",
		);
		getDebugLogger().info("pipeline-audit", "Duplicates found", {
			cloneCount: dupResult.clones.length,
			totalLines: dupResult.totalDuplicateLines,
		});
	} else if (dupResult.status === "no_jscpd") {
		getDebugLogger().info("pipeline-audit", "jscpd not available, skipping duplicate check");
	} else if (dupResult.status === "error") {
		getDebugLogger().warn("pipeline-audit", "Duplicate check error", {
			message: dupResult.message,
		});
	}

	return { failureText: null, dupResult };
}

// ── Dead Code ──────────────────────────────────────────────────────

export interface DeadCodeGateResult {
	failureText: string | null;
	deadResult: DeadCodeResult;
}

/**
 * Step 1b: Dead code detection gate.
 * BLOCKING — dead code found rejects transition back to Implementation.
 */
export async function runDeadCodeGate(
	deps: PreGateDeps,
	config: SupervisorConfig,
	worktreePath: string,
): Promise<DeadCodeGateResult> {
	getDebugLogger().info("pipeline-audit", "Running dead code check", { worktreePath });
	const runDeadCodeCheckFn = deps.runDeadCodeCheckFn ?? runDeadCodeCheck;
	const deadResult = await runDeadCodeCheckFn(
		deps.execFn,
		worktreePath,
		config.defaultBranch || "main",
	);

	if (deadResult.status === "dead_found") {
		const findingCount = deadResult.findings.length;
		const totalLines = deadResult.totalDeadLines;
		const msg = `DEAD_CODE_FOUND: ${findingCount} finding(s) found (${totalLines} lines)`;
		deps.ui.notify(
			`Dead code detected: ${findingCount} finding(s) found (${totalLines} lines). Fix before audit.`,
			"warning",
		);
		getDebugLogger().info("pipeline-audit", "Blocking — dead code found", {
			findingCount,
			totalLines,
		});

		const deadContext = buildDeadCodeContext(deadResult);
		return { failureText: `--- Dead Code Gate ---\n${deadContext || msg}`, deadResult };
	} else if (deadResult.status === "no_knip") {
		getDebugLogger().info("pipeline-audit", "knip not available, skipping dead code check");
	} else if (deadResult.status === "error") {
		getDebugLogger().warn("pipeline-audit", "Dead code check error", {
			message: deadResult.message,
		});
	}

	return { failureText: null, deadResult };
}

// ── Package Safety ─────────────────────────────────────────────────

export interface PackageSafetyGateResult {
	failureText: null;
	safetyResult?: PackageSafetyAuditResult;
}

/**
 * Step 2: Package safety audit (non-blocking — informational).
 * Checks all npm dependencies in the worktree's package.json for
 * package age safety.
 */
export async function runPackageSafetyGate(
	deps: PreGateDeps,
	config: SupervisorConfig,
	worktreePath: string,
): Promise<PackageSafetyGateResult> {
	let safetyResult: PackageSafetyAuditResult | undefined;
	try {
		const runPackageSafetyAuditFn = deps.runPackageSafetyAuditFn ?? runPackageSafetyAudit;
		safetyResult = await runPackageSafetyAuditFn(deps.execFn, worktreePath);
		if (safetyResult.status === "blocked") {
			const blockedPkgs = safetyResult.results
				.filter((r) => r.blocked)
				.map((r) => r.packageName)
				.join(", ");
			deps.ui.notify(
				`Package safety: ${safetyResult.results.filter((r) => r.blocked).length} blocked package(s): ${blockedPkgs}. Auditor may flag this.`,
				"warning",
			);
			getDebugLogger().info("pipeline-audit", "Package safety check found blocked packages", {
				blockedCount: safetyResult.results.filter((r) => r.blocked).length,
				results: safetyResult.results,
			});
		} else if (safetyResult.status === "error") {
			getDebugLogger().warn("pipeline-audit", "Package safety check error", {
				message: safetyResult.message,
			});
		} else {
			getDebugLogger().info("pipeline-audit", "Package safety check passed", {
				checkedCount: safetyResult.results.length,
			});
		}
	} catch (safetyErr: unknown) {
		getDebugLogger().warn("pipeline-audit", "Package safety check threw", {
			error: safetyErr instanceof Error ? safetyErr.message : String(safetyErr),
		});
	}

	return { failureText: null, safetyResult };
}

// ── OSV Vulnerability Scan ─────────────────────────────────────────

export interface OsvGateResult {
	failureText: string | null;
	vulnResult?: OsvScanResult;
}

/**
 * Step 2b: OSV vulnerability scan gate (non-blocking — informational,
 * configurable to blocking via vulnGateBlocking). Scans all lockfiles
 * in the worktree for known CVEs.
 */
export async function runOsvGate(
	deps: PreGateDeps,
	config: SupervisorConfig,
	worktreePath: string,
): Promise<OsvGateResult> {
	let vulnResult: OsvScanResult | undefined;
	try {
		const runVulnScanFn = deps.runVulnScanFn ?? runVulnScan;
		vulnResult = await runVulnScanFn(deps.execFn, worktreePath, {
			timeoutSec: config.vulnGateTimeoutSec ?? 60,
		});

		if (vulnResult.status === "vulns_found") {
			const c = vulnResult.counts;
			const parts: string[] = [];
			if (c.critical > 0) parts.push(`${c.critical} critical`);
			if (c.high > 0) parts.push(`${c.high} high`);
			if (c.medium > 0) parts.push(`${c.medium} medium`);
			if (c.low > 0) parts.push(`${c.low} low`);
			if (c.unknown > 0) parts.push(`${c.unknown} unknown`);
			const severitySummary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
			deps.ui.notify(
				`Vulnerabilities found: ${vulnResult.findings.length} issue(s)${severitySummary}. Auditor will review.`,
				"warning",
			);
			getDebugLogger().info("pipeline-audit", "Vulnerabilities found", {
				count: vulnResult.findings.length,
				counts: vulnResult.counts,
			});

			// Blocking check: if vulnGateBlocking is enabled AND critical vulns exist
			if (config.vulnGateBlocking && vulnResult.counts.critical > 0) {
				const vulnContext = buildVulnContext(vulnResult);
				return { failureText: `--- OSV Vulnerability Gate ---\n${vulnContext}`, vulnResult };
			}
		} else if (vulnResult.status === "error") {
			deps.ui.notify(
				`Vulnerability scan error: ${vulnResult.message || "Unknown error"}`,
				"warning",
			);
			getDebugLogger().warn("pipeline-audit", "Vulnerability scan error", {
				message: vulnResult.message,
			});
		} else if (vulnResult.status === "no_osv_scanner") {
			getDebugLogger().info("pipeline-audit", "osv-scanner not installed, skipping vuln check");
		} else if (vulnResult.status === "no_lockfiles") {
			getDebugLogger().info("pipeline-audit", "No lockfiles found, skipping vuln check");
		} else {
			getDebugLogger().info("pipeline-audit", "Vulnerability scan clean");
		}
	} catch (vulnErr: unknown) {
		getDebugLogger().warn("pipeline-audit", "Vulnerability scan threw", {
			error: vulnErr instanceof Error ? vulnErr.message : String(vulnErr),
		});
	}

	return { failureText: null, vulnResult };
}

// ── Requirements Traceability ──────────────────────────────────────

export interface TraceabilityGateResult {
	failureText: null;
}

/**
 * Step 4: Requirements traceability check (non-blocking — informational).
 * Runs deterministic checks cross-referencing issue requirements against
 * the diff. Produces structured gap list surfaced to the auditor agent.
 */
export async function runTraceabilityGate(
	deps: PreGateDeps,
	config: SupervisorConfig,
	worktreePath: string,
): Promise<TraceabilityGateResult> {
	try {
		const runRequirementsTraceabilityFn =
			deps.runRequirementsTraceabilityFn ?? runRequirementsTraceability;
		const traceGaps = await runRequirementsTraceabilityFn(
			deps.execFn,
			worktreePath,
			config.defaultBranch || "main",
			{
				body: deps.filteredData?.body || "",
				comments: (deps.filteredData?.comments || []).map((c: { body: string }) => ({
					author: "unknown",
					body: c.body,
				})),
			},
			deps.issueTitle,
		);
		if (traceGaps.length > 0) {
			const gapSummary = traceGaps.map((g) => `[${g.severity}] ${g.check}: ${g.detail}`).join("; ");
			deps.ui.notify(
				`Requirements traceability: ${traceGaps.length} gap(s) found. Auditor will review.`,
				"info",
			);
			getDebugLogger().info("pipeline-audit", "Traceability gaps found", {
				gapCount: traceGaps.length,
				summary: gapSummary,
			});
		} else {
			getDebugLogger().info("pipeline-audit", "No traceability gaps found");
		}
	} catch (traceErr: unknown) {
		const traceMsg = traceErr instanceof Error ? traceErr.message : String(traceErr);
		deps.ui.notify(`Requirements traceability check threw: ${traceMsg}`, "info");
		getDebugLogger().warn("pipeline-audit", "Requirements traceability threw", {
			error: traceMsg,
		});
	}

	return { failureText: null };
}
