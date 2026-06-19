// ─── Pipeline Helpers ────────────────────────────────────────────
// Extracted from handler.ts with injected ExecFn/NotifyFn/ErrorCollector dependencies.
// Independently unit-testable: no direct pi/ctx dependency.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	FilteredIssueData,
	ParsedAgent,
	ProjectField,
	ProjectItem,
} from "../config/types.ts";
import {
	filterIssueData,
	getProjectFields,
	getProjectItems,
	getProjectId,
	checkBlockedByDependencies,
} from "../github/index.ts";
import { parseAgentFile } from "../agent/loader.ts";
import type { ErrorCollector } from "./error-collector.ts";

// ─── Dependency Injection Interfaces ──────────────────────────────

/**
 * ExecFn: executes a shell command (like pi.exec).
 * Returns {code, stdout, stderr}.
 */
export type ExecFn = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * NotifyFn: notification callbacks for UI status updates.
 */
export interface NotifyFn {
	info: (msg: string) => void;
	error: (msg: string) => void;
}

// ─── Internal: wrap exec as ExtensionAPI for github module functions ──

function execAsPi(exec: ExecFn): ExtensionAPI {
	return { exec } as ExtensionAPI;
}

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
	exec: ExecFn,
	notify: NotifyFn,
	config: SupervisorConfig,
	_issueNum: number,
	collector?: ErrorCollector,
): Promise<ProjectBoardResult> {
	const pi = execAsPi(exec);
	try {
		const fields = await getProjectFields(pi, config.projectNumber);
		const items = await getProjectItems(pi, config.projectNumber);
		const projectId = await getProjectId(pi, config.projectNumber);

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
	exec: ExecFn,
	notify: NotifyFn,
	config: SupervisorConfig,
	issueNum: number,
	collector?: ErrorCollector,
): Promise<boolean> {
	const pi = execAsPi(exec);
	try {
		const depsResult = await checkBlockedByDependencies(pi, issueNum, config.repo);
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
	exec: ExecFn,
	config: SupervisorConfig,
	issueNum: number,
	fallbackData: Record<string, unknown>,
	collector?: ErrorCollector,
): Promise<FilteredIssueData> {
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
		return filterIssueData(JSON.parse(raw.stdout || "{}"), config.codeowners);
	} catch {
		collector?.push(
			"helpers",
			"warn",
			`Failed to fetch fresh data for issue #${issueNum}, using cached data`,
		);
		return filterIssueData(fallbackData, config.codeowners);
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
