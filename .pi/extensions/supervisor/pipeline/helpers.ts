// ─── Pipeline Helpers ────────────────────────────────────────────
// Extracted from handler.ts with injected ExecFn/NotifyFn/ErrorCollector dependencies.
// Independently unit-testable: no direct pi/ctx dependency.

import type { ExecFn } from "../../lib/port-types.ts";
import type {
	SupervisorConfig,
	FilteredIssueData,
	ParsedAgent,
	ProjectField,
	ProjectItem,
} from "../config/types.ts";
import { filterIssueData, type RawIssueData } from "../lib/issue-filter.ts";
import type { GitHubPort } from "../github/ports.ts";
import { parseAgentFile } from "../agent/loader.ts";
import type { ErrorCollector } from "./error-collector.ts";

// NotifyFn and its adapters moved to shared/result.ts (issue #2138) so the
// goal-loop extension shares the exact same port. Re-exported here so the
// Supervisor's historical import paths (`./helpers.ts`) keep working.
import { nullNotify, toNotifyFn } from "../../shared/result.ts";
import type { NotifyFn, NotifyTarget } from "../../shared/result.ts";
export { nullNotify, toNotifyFn };
export type { NotifyFn, NotifyTarget };

// ─── Fetch Issue ─────────────────────────────────────────────────

export async function fetchIssue(
	exec: ExecFn,
	notify: NotifyFn,
	config: SupervisorConfig,
	issueNum: number,
	collector?: ErrorCollector,
): Promise<Record<string, unknown> | null> {
	try {
		return await exec("gh", [
			"issue",
			"view",
			String(issueNum),
			"--repo",
			config.repo,
			"--json",
			"number,title,body,author,comments",
		]).then((r) => JSON.parse(r.stdout || "{}"));
	} catch {
		const msg = `Issue #${issueNum} not found in ${config.repo}`;
		notify.error(msg);
		collector?.push("helpers", "error", msg);
		return null;
	}
}

// ─── Read Project Board ──────────────────────────────────────────

export interface ProjectBoardResult {
	fields: ProjectField[] | null;
	items: ProjectItem[];
	projectId: string;
	statusField: ProjectField | null;
}

export async function readProjectBoard(
	notify: NotifyFn,
	config: SupervisorConfig,
	port: GitHubPort,
	collector?: ErrorCollector,
): Promise<ProjectBoardResult> {
	try {
		const fields = await port.getProjectFields(config.projectNumber);
		const items = await port.getProjectItems(config.projectNumber);
		const projectId = await port.getProjectId(config.projectNumber);

		const statusField =
			fields.find((f) => f.name.toLowerCase() === config.statusField?.toLowerCase()) || null;
		if (!statusField) {
			const msg = `Status field '${config.statusField}' not found. Fields: ${fields.map((f) => f.name).join(", ")}`;
			notify.error(msg);
			collector?.push("helpers", "error", msg);
			return { fields: null, items: [], projectId: "", statusField: null };
		}
		return { fields, items, projectId, statusField };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("missing required scopes")) {
			const scopeMsg = "GitHub token missing 'project' scope. Run: gh auth refresh -s project";
			notify.error(scopeMsg);
			collector?.push("helpers", "error", scopeMsg);
		} else {
			notify.error(`Failed to read project board: ${msg}`);
			collector?.push("helpers", "error", `Failed to read project board: ${msg}`);
		}
		return { fields: null, items: [], projectId: "", statusField: null };
	}
}

// ─── Check Dependencies ──────────────────────────────────────────

export async function checkDependencies(
	notify: NotifyFn,
	config: SupervisorConfig,
	issueNum: number,
	port: GitHubPort,
	collector?: ErrorCollector,
): Promise<boolean> {
	try {
		const depsResult = await port.checkBlockedByDependencies(issueNum, config.repo);
		if (depsResult.blocked) {
			const lines = depsResult.blockers.map(
				(b) => `${b.type === "pullrequest" ? "!" : "#"}${b.number}: ${b.title} (open)`,
			);
			const msg = `Issue #${issueNum} is blocked by unresolved dependencies:\n${lines.join("\n")}`;
			notify.error(msg);
			collector?.push("helpers", "error", msg);
			return false;
		}
		return true;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		notify.error(`Dependency check failed: ${msg}`);
		collector?.push("helpers", "error", `Dependency check failed: ${msg}`);
		return false;
	}
}

// ─── Fetch Fresh Issue Data ──────────────────────────────────────

/**
 * Fresh issue data, plus a degraded variant when complete comment discovery or
 * the automation identity is unavailable. The audit-rejection upsert must not
 * proceed on degraded data (issue #2044 audit findings #1/#2): an incomplete
 * page or an unknown identity could hide the prior rejection. Callers decide
 * whether the step needs the verified data; `data` stays usable best-effort.
 */
export type FreshIssueResolution =
	| { kind: "loaded"; data: FilteredIssueData }
	| { kind: "failed"; reason: string; data: FilteredIssueData };

export async function fetchFreshIssueData(
	exec: ExecFn,
	config: SupervisorConfig,
	issueNum: number,
	fallbackData: Record<string, unknown>,
	collector?: ErrorCollector,
	port?: GitHubPort,
): Promise<FreshIssueResolution> {
	let rawIssue: RawIssueData;
	try {
		const raw = await exec("gh", [
			"issue",
			"view",
			String(issueNum),
			"--repo",
			config.repo,
			"--json",
			"number,title,body,author,comments",
		]);
		rawIssue = JSON.parse(raw.stdout || "{}");
	} catch {
		collector?.push(
			"helpers",
			"warn",
			`Failed to fetch fresh data for issue #${issueNum}, using cached data`,
		);
		rawIssue = fallbackData as RawIssueData;
	}

	// Paginate comment discovery via the port (issue #2044 audit finding #4);
	// the prior rejection can sit beyond the page `gh issue view` returns. A
	// failed paginated request must stop the loop: the single gh page is not
	// proof that no prior rejection exists (issue #2044 audit finding #1).
	if (port) {
		try {
			rawIssue = { ...rawIssue, comments: await port.listComments(issueNum, config.repo) };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			collector?.push(
				"helpers",
				"error",
				`Failed to list all comments for issue #${issueNum}: ${msg}`,
			);
			return {
				kind: "failed",
				reason: `Cannot list all comments for issue #${issueNum}: ${msg}`,
				data: filterIssueData(rawIssue, config.codeowners),
			};
		}
	}

	if (!port) return { kind: "loaded", data: filterIssueData(rawIssue, config.codeowners) };

	// Without a verified identity the prior rejection cannot be told apart from
	// a forgery, so rejection processing stops instead of posting a duplicate
	// (issue #2044 audit finding #2).
	const automationLogin = await resolveAutomationLogin(port, collector);
	if (!automationLogin) {
		return {
			kind: "failed",
			reason: `Cannot resolve authenticated login for issue #${issueNum}`,
			data: filterIssueData(rawIssue, config.codeowners),
		};
	}
	return { kind: "loaded", data: filterIssueData(rawIssue, config.codeowners, automationLogin) };
}

/**
 * Login of the token owner, used to verify that rejection comments are the
 * supervisor's own. Unresolved → undefined, which callers must treat as a stop
 * (fail closed: without a verified identity, prior rejections cannot be told
 * apart from forged ones — issue #2044 audit findings #2/#3).
 */
export async function resolveAutomationLogin(
	port: GitHubPort,
	collector?: ErrorCollector,
): Promise<string | undefined> {
	try {
		return await port.getAuthenticatedLogin();
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		collector?.push("helpers", "error", `Failed to resolve authenticated login: ${msg}`);
		return undefined;
	}
}

// ─── Load Agent File ─────────────────────────────────────────────

export async function loadAgentFile(
	exec: ExecFn,
	notify: NotifyFn,
	cwd: string,
	agentName: string,
	collector?: ErrorCollector,
): Promise<ParsedAgent | null> {
	const agentPath = `.pi/extensions/supervisor/agents/${agentName}.md`;
	try {
		await exec("test", ["-f", agentPath], { cwd });
	} catch {
		const msg = `Agent file not found: ${agentPath}`;
		notify.error(msg);
		collector?.push("helpers", "error", msg);
		return null;
	}
	try {
		return parseAgentFile(agentPath);
	} catch (err: unknown) {
		const msg = `Failed to parse agent: ${err instanceof Error ? err.message : String(err)}`;
		notify.error(msg);
		collector?.push("helpers", "error", msg);
		return null;
	}
}
