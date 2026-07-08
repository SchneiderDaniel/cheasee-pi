// ─── Pipeline Helpers ────────────────────────────────────────────
// Extracted from handler.ts with injected GitHubPort/NotifyFn/ErrorCollector dependencies.
// Independently unit-testable: no direct pi/ctx dependency.

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
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

/** Exec function type for subprocess calls — port matching the real dependency. */
export type ExecFn = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/**
 * NotifyFn: notification callbacks for UI status updates.
 */
export interface NotifyFn {
	info: (msg: string) => void;
	error: (msg: string) => void;
}

// ─── Fetch Issue ─────────────────────────────────────────────────

export async function fetchIssue(
	port: GitHubPort,
	notify: NotifyFn,
	config: SupervisorConfig,
	issueNum: number,
	collector?: ErrorCollector,
): Promise<Record<string, unknown> | null> {
	try {
		const issue = await port.getIssue(issueNum, config.repo);
		if (!issue) {
			const msg = `Issue #${issueNum} not found in ${config.repo}`;
			notify.error(msg);
			collector?.push("helpers", "error", msg);
			return null;
		}
		return {
			number: issue.number,
			title: issue.title,
			body: issue.body,
			author: issue.author,
			comments: issue.comments,
		} as Record<string, unknown>;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		notify.error(`Failed to fetch issue #${issueNum}: ${msg}`);
		collector?.push("helpers", "error", `Failed to fetch issue #${issueNum}: ${msg}`);
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
	port: GitHubPort,
	notify: NotifyFn,
	config: SupervisorConfig,
	_issueNum: number,
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
	port: GitHubPort,
	notify: NotifyFn,
	config: SupervisorConfig,
	issueNum: number,
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

export async function fetchFreshIssueData(
	port: GitHubPort,
	config: SupervisorConfig,
	issueNum: number,
	fallbackData: Record<string, unknown>,
	collector?: ErrorCollector,
): Promise<FilteredIssueData> {
	try {
		const raw = await port.getIssueWithComments(issueNum, config.repo);
		if (!raw) {
			collector?.push(
				"helpers",
				"warn",
				`Failed to fetch fresh data for issue #${issueNum}, using cached data`,
			);
			return filterIssueData(fallbackData as unknown as RawIssueData, config.codeowners);
		}
		return filterIssueData(raw as unknown as RawIssueData, config.codeowners);
	} catch {
		collector?.push(
			"helpers",
			"warn",
			`Failed to fetch fresh data for issue #${issueNum}, using cached data`,
		);
		return filterIssueData(fallbackData as unknown as RawIssueData, config.codeowners);
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
