// ─── gh CLI wrappers — typed versions ─────────────────────────────
// Low-level gh/ghJson/ghGraphQL with typed generic returns.
// Replaces raw `Promise<any>` returns from the old github.ts.

import type { ExecFn } from "../pipeline/helpers.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	ProjectField,
	ProjectItem,
	DepsResult,
	PrConflictInfo,
	GhTimelineResponse,
} from "../config/types.ts";
import type { GitHubPort } from "./ports.ts";
import type {
	ProjectFieldsResponse,
	ProjectItemsResponse,
	ProjectIdResponse,
} from "./types.ts";

// ─── gh() — raw CLI wrapper ───────────────────────────────────────

// Cache GH_TOKEN from env or ~/.config/gh/hosts.yml to work around
// WSL auth context mismatch where pi.exec("gh", ...) can return 401
// even though the gh binary itself is properly authenticated.
// On WSL, pi.exec passes environment correctly but gh sometimes
// fails to find its credentials. Injecting GH_TOKEN explicitly
// ensures consistent auth across shell and pi.exec contexts.
const getGhToken = (() => {
	let token: string | null = null;
	return (): string | null => {
		if (token !== null) return token;
		if (process.env.GH_TOKEN && process.env.GH_TOKEN.length > 0) {
			token = process.env.GH_TOKEN;
			return token;
		}
		try {
			const configPath = join(homedir(), ".config", "gh", "hosts.yml");
			const yml = readFileSync(configPath, "utf8");
			const match = yml.match(/oauth_token:\s+(\S+)/);
			token = match ? match[1] : null;
		} catch {
			token = null;
		}
		return token;
	};
})();

export async function gh(
	exec: ExecFn,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<string> {
	const log = getDebugLogger();
	const cmdLabel = args.slice(0, 2).join(" ");
	log.debug("gh-client", `gh ${cmdLabel}`, {
		args: args.slice(0, 8),
		timeout: opts?.timeout,
	});

	// Call gh via bash to inject GH_TOKEN, working around exec auth
	// context issues on WSL.  Uses "$@" passthrough to avoid shell escaping.
	const ghToken = getGhToken();
	const shellArgs = ghToken
		? ["-c", `GH_TOKEN='${ghToken.replace(/'/g, "'\\''")}' gh "$@"`, "_", ...args]
		: args;

	const result = await exec(ghToken ? "bash" : "gh", shellArgs, {
		signal: opts?.signal,
		timeout: opts?.timeout ?? 30_000,
	});
	if (result.code !== 0) {
		log.warn("gh-client", `gh ${cmdLabel} failed (code ${result.code})`, {
			args: args.slice(0, 8),
			stderr: (result.stderr || "").slice(0, 500),
		});
		throw new Error(`gh ${args[0]} failed: ${result.stderr || result.stdout}`);
	}
	log.debug("gh-client", `gh ${cmdLabel} OK`, {
		stdoutLen: (result.stdout || "").length,
	});
	return (result.stdout || "").trim();
}

// ─── ghJson<T>() — typed JSON output ──────────────────────────────

export async function ghJson<T = unknown>(
	exec: ExecFn,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<T | null> {
	const output = await gh(exec, args, opts);
	if (!output) return null;
	return JSON.parse(output) as T;
}

// ─── ghGraphQL<T>() — typed GraphQL wrapper ───────────────────────

export async function ghGraphQL<T = unknown>(
	exec: ExecFn,
	query: string,
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<T | null> {
	const log = getDebugLogger();
	const queryPreview = query.replace(/\s+/g, " ").slice(0, 120);
	log.debug("gh-client", `ghGraphQL: ${queryPreview}...`);
	const result = await gh(
		exec,
		["api", "graphql", "--header", "Accept: application/vnd.github+json", "-f", `query=${query}`],
		opts,
	);
	if (!result) {
		log.warn("gh-client", "ghGraphQL returned empty result");
		return null;
	}
	const parsed = JSON.parse(result) as T;
	log.debug("gh-client", `ghGraphQL OK — response len: ${result.length}`);
	return parsed;
}

// ─── GitHubPort Factory ─────────────────────────────────────────
// gh CLI-backed adapter implementing the 8-method GitHubPort interface.
// Each method delegates to gh() / ghJson() / ghGraphQL().

/**
 * Create a GitHubPort backed by the gh CLI.
 * The exec function is captured in the closure — no per-call exec needed.
 */
export function createGitHubPort(exec: ExecFn): GitHubPort {
	const log = getDebugLogger();

	return {
		async postIssueComment(
			issueNum: number,
			repo: string,
			body: string,
		): Promise<void> {
			const preview = body.slice(0, 200).replace(/\n/g, " ");
			log.info("gh-port", `Posting comment on #${issueNum} (${repo})`, {
				issueNum,
				repo,
				bodyLen: body.length,
				preview,
			});
			const tempFile = join(
				"ignore",
				`comment-body-${issueNum}-${Date.now()}.md`,
			);
			try {
				await mkdir(dirname(tempFile), { recursive: true });
				await writeFile(tempFile, body, "utf-8");
				await gh(exec, [
					"issue",
					"comment",
					String(issueNum),
					"--repo",
					repo,
					"--body-file",
					tempFile,
				]);
				log.info("gh-port", `Comment posted on #${issueNum}`);
			} finally {
				try {
					await unlink(tempFile);
				} catch {
					// best-effort cleanup
				}
			}
		},

		async getProjectFields(
			projectNumber: number,
		): Promise<ProjectField[]> {
			log.info("gh-port", `Reading fields for project #${projectNumber}`);
			const resp = await ghGraphQL<ProjectFieldsResponse>(
				exec,
				`{
				viewer {
					projectV2(number: ${projectNumber}) {
						fields(first: 10) {
							nodes {
								... on ProjectV2Field { id name dataType }
								... on ProjectV2SingleSelectField { id name dataType options { id name } }
								... on ProjectV2IterationField { id name dataType }
							}
						}
					}
				}
			}`,
			);
			const nodes =
				resp?.data?.viewer?.projectV2?.fields?.nodes || [];
			const fields = nodes.map((n) => ({
				id: n.id,
				name: n.name,
				type: n.dataType || "UNKNOWN",
				options: n.options || undefined,
			}));
			log.info(
				"gh-port",
				`Got ${fields.length} fields for project #${projectNumber}`,
				{ fieldNames: fields.map((f) => f.name) },
			);
			return fields;
		},

		async getProjectItems(
			projectNumber: number,
		): Promise<ProjectItem[]> {
			log.info("gh-port", `Reading items for project #${projectNumber}`);
			const allItems: ProjectItem[] = [];
			let after: string | null = null;
			let hasNextPage = true;

			while (hasNextPage) {
				const afterArg: string = after ? `, after: "${after}"` : "";
				const resp = await ghGraphQL<ProjectItemsResponse>(
					exec,
					`{
					viewer {
						projectV2(number: ${projectNumber}) {
							items(first: 100${afterArg}) {
								pageInfo { hasNextPage endCursor }
								nodes {
									id
									content {
										... on Issue { number url }
										... on PullRequest { number url }
									}
									fieldValues(first: 20) {
										nodes {
											... on ProjectV2ItemFieldSingleSelectValue {
												name
												field { ... on ProjectV2FieldCommon { id name } }
											}
											... on ProjectV2ItemFieldTextValue {
												text
												field { ... on ProjectV2FieldCommon { id name } }
											}
										}
									}
								}
							}
						}
					}
					}`,
				);
				const page = resp?.data?.viewer?.projectV2?.items;
				const nodes = page?.nodes || [];
				for (const n of nodes) {
					const fieldNodes = n.fieldValues?.nodes || [];
					let status: string | undefined;
					const fv: Array<{
						fieldId: string;
						value: string;
						optionId?: string;
					}> = [];
					for (const f of fieldNodes) {
						if (
							f.name &&
							f.field?.name?.toLowerCase() === "status"
						) {
							status = f.name;
						}
						if (f.field?.id) {
							fv.push({
								fieldId: f.field.id,
								value: f.name || f.text || "",
								optionId: undefined,
							});
						}
					}
					allItems.push({
						id: n.id,
						status,
						content: n.content
							? {
									url: n.content.url,
									number: n.content.number,
								}
							: undefined,
						fieldValues:
							fv.length > 0 ? fv : undefined,
					});
				}
				hasNextPage =
					page?.pageInfo?.hasNextPage ?? false;
				after = page?.pageInfo?.endCursor ?? null;
			}

			log.info(
				"gh-port",
				`Loaded ${allItems.length} items from project #${projectNumber}`,
			);
			return allItems;
		},

		async getProjectId(
			projectNumber: number,
		): Promise<string> {
			log.debug("gh-port", `Get project ID for #${projectNumber}`);
			const resp = await ghGraphQL<ProjectIdResponse>(
				exec,
				`{
				viewer {
					projectV2(number: ${projectNumber}) {
						id
					}
				}
			}`,
			);
			const id = resp?.data?.viewer?.projectV2?.id || "";
			log.debug(
				"gh-port",
				`Project #${projectNumber} ID: ${id ? id.slice(0, 20) + "..." : "NOT FOUND"}`,
			);
			return id;
		},

		async setItemStatusField(
			itemId: string,
			projectId: string,
			fieldId: string,
			optionId: string,
		): Promise<void> {
			log.info("gh-port", "Setting item status", {
				itemId: itemId.slice(0, 16) + "...",
				optionId: optionId.slice(0, 16) + "...",
			});
			await gh(exec, [
				"project",
				"item-edit",
				"--id",
				itemId,
				"--project-id",
				projectId,
				"--field-id",
				fieldId,
				"--single-select-option-id",
				optionId,
			]);
			log.info("gh-port", "Item status updated");
		},

		async checkBlockedByDependencies(
			issueNum: number,
			repo: string,
		): Promise<DepsResult> {
			log.info(
				"gh-port",
				`Checking deps for #${issueNum} on ${repo}`,
			);
			const [owner, name] = repo.split("/");
			if (!owner || !name) {
				throw new Error(
					`Invalid repo format: ${repo} (expected owner/name)`,
				);
			}

			const query = `
				query {
					repository(owner: "${owner}", name: "${name}") {
						issue(number: ${issueNum}) {
							timelineItems(itemTypes: [BLOCKED_BY_ADDED_EVENT, BLOCKED_BY_REMOVED_EVENT], first: 100) {
								nodes {
									__typename
									... on BlockedByAddedEvent {
										blockingIssue {
											id
											number
											title
											state
										}
									}
									... on BlockedByRemovedEvent {
										blockingIssue {
											id
											number
											title
											state
										}
									}
								}
							}
						}
					}
				}`;

			let response: GhTimelineResponse | null;
			try {
				response = await ghGraphQL<GhTimelineResponse>(
					exec,
					query,
				);
			} catch (err: unknown) {
				const msg =
					err instanceof Error ? err.message : String(err);
				throw new Error(
					`Failed to query GitHub for dependencies: ${msg}`,
				);
			}

			if (
				response?.errors &&
				response.errors.length > 0
			) {
				const msgs = response.errors
					.map((e) => e.message)
					.join("; ");
				throw new Error(
					`GitHub GraphQL error: ${msgs}`,
				);
			}

			const nodes =
				response?.data?.repository?.issue?.timelineItems
					?.nodes;
			if (!nodes || nodes.length === 0) {
				return { blocked: false, blockers: [] };
			}

			const lastEventByIssue = new Map<
				string,
				string
			>();
			for (const node of nodes) {
				const blockingId = node?.blockingIssue?.id;
				if (!blockingId) continue;
				lastEventByIssue.set(
					blockingId,
					node.__typename,
				);
			}

			const blockers: DepsResult["blockers"] = [];
			const seenNumbers = new Set<number>();
			for (const node of nodes) {
				const issue = node.blockingIssue;
				if (!issue) continue;
				const lastEvent = lastEventByIssue.get(
					issue.id,
				);
				if (lastEvent !== "BlockedByAddedEvent")
					continue;
				if (seenNumbers.has(issue.number)) continue;
				seenNumbers.add(issue.number);
				if (issue.state === "CLOSED") continue;
				blockers.push({
					number: issue.number,
					title: issue.title || "",
					type: "issue",
					state: issue.state || "UNKNOWN",
				});
			}

			const result: DepsResult = {
				blocked: blockers.length > 0,
				blockers,
			};
			log.info(
				"gh-port",
				`Deps check: blocked=${result.blocked}, blockers=${result.blockers.length}`,
			);
			return result;
		},

		async createPullRequest(input: {
			repo: string;
			base: string;
			head: string;
			title: string;
			body?: string;
		}): Promise<{ number: number }> {
			const titlePreview = input.title.slice(0, 100);
			log.info("gh-port", `Creating PR: ${titlePreview}`, {
				repo: input.repo,
				base: input.base,
				head: input.head,
				titleLen: input.title.length,
				hasBody: !!input.body,
			});

			// Write body to temp file if provided
			let tempFile: string | undefined;
			if (input.body) {
				tempFile = join(
					"ignore",
					`pr-body-${Date.now()}.md`,
				);
				await mkdir(dirname(tempFile), {
					recursive: true,
				});
				await writeFile(tempFile, input.body, "utf-8");
			}

			try {
				const args: string[] = [
					"pr",
					"create",
					"--repo",
					input.repo,
					"--base",
					input.base,
					"--head",
					input.head,
					"--title",
					input.title,
				];
				if (tempFile) {
					args.push("--body-file", tempFile);
				}

				const rawOutput = await gh(exec, args);
				const urlMatch = rawOutput.match(
					/pull\/(\d+)/,
				);
				if (urlMatch) {
					const num = parseInt(urlMatch[1], 10);
					log.info(
						"gh-port",
						`PR #${num} created: ${input.head} → ${input.base}`,
					);
					return { number: num };
				}
				const numMatch = rawOutput.match(/^(\d+)$/);
				if (numMatch) {
					const num = parseInt(numMatch[1], 10);
					log.info(
						"gh-port",
						`PR #${num} created (numeric)`,
					);
					return { number: num };
				}

				throw new Error(
					`gh pr create failed to parse PR number from: ${rawOutput.slice(0, 200)}`,
				);
			} finally {
				if (tempFile) {
					try {
						await unlink(tempFile);
					} catch {
						// best-effort cleanup
					}
				}
			}
		},

		async listPullRequestsForBranch(
			branch: string,
			repo: string,
		): Promise<PrConflictInfo | null> {
			log.info(
				"gh-port",
				`List PRs for branch ${branch} on ${repo}`,
			);
			const result = await ghJson<
				Array<{
					number: number;
					mergeable: string;
					mergeStateStatus: string;
					headRefName: string;
					baseRefName: string;
				}>
			>(
				exec,
				[
					"pr",
					"list",
					"--repo",
					repo,
					"--head",
					branch,
					"--json",
					"number,mergeable,mergeStateStatus,headRefName,baseRefName",
				],
			);
			if (
				!result ||
				!Array.isArray(result) ||
				result.length === 0
			) {
				log.info(
					"gh-port",
					`No PR found for branch ${branch}`,
				);
				return null;
			}
			const pr = result[0];
			const conflictInfo: PrConflictInfo = {
				number: pr.number,
				hasConflict:
					pr.mergeable === "CONFLICTING" ||
					pr.mergeStateStatus === "DIRTY",
				mergeable: pr.mergeable || "UNKNOWN",
				mergeStateStatus:
					pr.mergeStateStatus || "UNKNOWN",
				headRefName: pr.headRefName,
				baseRefName: pr.baseRefName,
			};
			log.info(
				"gh-port",
				`PR #${pr.number} conflicts: ${conflictInfo.hasConflict}`,
			);
			return conflictInfo;
		},
	};
}
