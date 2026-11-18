// ─── Goal loop extension wiring ──────────────────────────────────
// Humble object layer (R1–R7). This module translates Pi events, commands and
// tools into `GoalService` calls — it holds no policy:
//
// - decisions come from `decideBoundary` (domain),
// - state transitions come from the record entity,
// - side-effect order comes from `GoalService`.
//
// It never calls `ctx.newSession` / session replacement. Session replacement
// from a lifecycle handler can deadlock the runtime, so a context rollover is a
// new runtime generation started by the service instead.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { failure, toNotifyFn, type Result } from "../shared/result.ts";
import { resolveModel } from "../shared/model/model-ref.ts";
import { resolveCurrentBranch, type ExecLike } from "../shared/git/worktree.ts";
import { prepareGoalLoopConfig } from "./config/goal-loop-settings.ts";
import {
	GoalService,
	type ClarificationSubmission,
	type GoalServiceDeps,
	type IterationReport,
} from "./application/goal-service.ts";
import type { ModelResolver, PullRequestPort } from "./application/ports.ts";
import { MarkdownGoalStore } from "./adapters/markdown-goal-store.ts";
import { GitGoalWorkspace } from "./adapters/git-goal-workspace.ts";
import { GitHubPullRequestAdapter, type OctokitLike } from "./adapters/github-pull-request.ts";
import {
	HarnessCheckRunner,
	PiGoalAgentRuntime,
	type InspectRunner,
} from "./adapters/pi-goal-runtime.ts";

/** Goal mode is exposed as `/goal` (R1). */
export const GOAL_COMMAND = "goal";

/** The resolved backend for one Pi session. */
export interface GoalLoopBackend {
	service: GoalService;
	/** Runtime whose compaction flag `session_compact` sets. */
	runtime?: { markCompaction(): void };
}

/** Wiring dependencies. Tests inject a backend resolver; production uses Pi. */
export interface GoalLoopWiringOptions {
	/** Build (or reuse) the backend for a context. Called once per session. */
	resolveBackend: (
		ctx: ExtensionContext | ExtensionCommandContext,
	) => Promise<Result<GoalLoopBackend>>;
}

type GoalSubcommand = "start" | "status" | "stop" | "resume" | "revise" | "cleanup";

interface ParsedGoalArgs {
	subcommand: GoalSubcommand;
	rest: string;
	flags: Set<string>;
}

/** Parse `/goal <sub> ...`; anything unrecognised is goal text to start. */
export function parseGoalArgs(args: string): ParsedGoalArgs {
	const trimmed = args.trim();
	if (trimmed === "") return { subcommand: "status", rest: "", flags: new Set() };
	const [head = "", ...tail] = trimmed.split(/\s+/);
	const flags = new Set(tail.filter((token) => token.startsWith("--")));
	switch (head) {
		case "status":
		case "stop":
		case "resume":
		case "revise":
		case "cleanup":
			return { subcommand: head, rest: trimmed.slice(head.length).trim(), flags };
		default:
			return { subcommand: "start", rest: trimmed, flags };
	}
}

/** Register `/goal`, the steering `input` handler and the settle boundary. */
export function registerGoalLoop(pi: ExtensionAPI, options: GoalLoopWiringOptions): void {
	let backend: GoalLoopBackend | null = null;
	const resolve = async (
		ctx: ExtensionContext | ExtensionCommandContext,
	): Promise<Result<GoalLoopBackend>> => {
		if (backend) return { ok: true, value: backend };
		const resolved = await options.resolveBackend(ctx);
		if (!resolved.ok) return resolved;
		backend = resolved.value;
		return resolved;
	};

	// One continuation per completed iteration, so a continuation cannot re-fire
	// for the settle it already answered (which would double-count iterations
	// and bypass the configured cap). A rollover starts a new generation, which
	// is a new key.
	const continuedKeys = new Set<string>();

	pi.registerCommand(GOAL_COMMAND, {
		description:
			"Run a verified goal loop: /goal <description> | status | stop | resume --approve | revise | cleanup --confirm",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const resolved = await resolve(ctx);
			if (!resolved.ok) {
				ctx.ui.notify(`goal: ${resolved.error}`, "error");
				return;
			}
			try {
				await handleCommand(resolved.value.service, parseGoalArgs(rawArgs), ctx, pi);
			} catch (err: unknown) {
				// A service rejection is surfaced as a UI error, never swallowed.
				ctx.ui.notify(`goal: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		const resolved = await resolve(ctx);
		if (!resolved.ok) return undefined;
		const { service } = resolved.value;
		const record = service.current();
		if (!record) return undefined;

		if (record.status === "clarifying") {
			const recorded = await service.recordClarificationMessage(event.text);
			if (!recorded.ok) {
				ctx.ui.notify(`goal: ${recorded.error}`, "error");
				return { action: "handled" as const };
			}
			// The clarification answer still reaches the agent as a normal prompt;
			// the record keeps a copy so a context reset cannot lose it.
			return undefined;
		}
		if (!service.hasActiveGoal()) return undefined;
		const steered = await service.steer(event.text);
		if (!steered.ok) {
			ctx.ui.notify(`goal: ${steered.error}`, "error");
			return { action: "handled" as const };
		}
		return undefined;
	});

	pi.on("agent_before_settle", async (_event, ctx) => {
		const resolved = await resolve(ctx);
		if (!resolved.ok) return undefined;
		const { service } = resolved.value;
		const record = service.current();
		if (!record || !service.hasActiveGoal()) return undefined;

		const key = `${record.generation}:${record.iterations}`;
		if (continuedKeys.has(key)) return undefined;

		const boundary = await service.onBoundary();
		if (!boundary.ok) {
			ctx.ui.notify(`goal: ${boundary.error}`, "error");
			return undefined;
		}
		if (boundary.value.decision.kind === "continue") {
			continuedKeys.add(key);
			return { continue: true };
		}
		return undefined;
	});

	pi.on("session_compact", async () => {
		backend?.runtime?.markCompaction();
	});

	registerGoalTools(pi, resolve);
}

/**
 * Agent-facing tools. The agent never writes the record: it submits a
 * clarification or an iteration report and the loop owns the file.
 */
function registerGoalTools(
	pi: ExtensionAPI,
	resolve: (ctx: ExtensionContext | ExtensionCommandContext) => Promise<Result<GoalLoopBackend>>,
): void {
	pi.registerTool({
		name: "goal_submit_clarification",
		label: "Submit Goal Clarification",
		description:
			"Submit the clarified goal and its acceptance criteria. Use ready=false with questions while the goal is ambiguous, unreachable or unverifiable. Every criterion needs a command or inspect verifier.",
		parameters: Type.Object({
			ready: Type.Boolean(),
			clarifiedGoal: Type.Optional(Type.String()),
			questions: Type.Optional(Type.Array(Type.String())),
			reachable: Type.Optional(Type.Boolean()),
			criteria: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						text: Type.String(),
						verifier: Type.Object({
							kind: Type.Union([Type.Literal("command"), Type.Literal("inspect")]),
							argv: Type.Optional(Type.Array(Type.String())),
							pinned: Type.Optional(
								Type.Array(Type.Object({ path: Type.String(), sha256: Type.String() })),
							),
							expectExit: Type.Optional(Type.Number()),
							instruction: Type.Optional(Type.String()),
						}),
					}),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = await resolve(ctx);
			if (!resolved.ok) {
				return {
					content: [{ type: "text" as const, text: `goal: ${resolved.error}` }],
					details: undefined,
				};
			}
			const submission: ClarificationSubmission = {
				ready: params.ready,
				clarifiedGoal: params.clarifiedGoal,
				questions: params.questions,
				reachable: params.reachable,
				criteria: params.criteria?.map((c) => ({
					id: c.id,
					text: c.text,
					verifier: toVerifier(c.verifier),
				})),
			};
			const outcome = await resolved.value.service.submitClarification(submission);
			if (!outcome.ok) {
				return {
					content: [{ type: "text" as const, text: `goal: ${outcome.error}` }],
					details: undefined,
				};
			}
			const value = outcome.value;
			const text = value.started
				? `goal ${value.record.id} started in ${value.record.worktree} on branch ${value.record.branch}`
				: `clarification incomplete:\n${value.questions.map((q) => `- ${q}`).join("\n")}`;
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "goal_report_iteration",
		label: "Report Goal Iteration",
		description:
			"Report the outcome of one work iteration: a short summary, the single next action, and an optional blocker. The loop verifies every acceptance criterion itself — do not claim completion.",
		parameters: Type.Object({
			summary: Type.String(),
			nextAction: Type.String(),
			blocker: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = await resolve(ctx);
			if (!resolved.ok) {
				return {
					content: [{ type: "text" as const, text: `goal: ${resolved.error}` }],
					details: undefined,
				};
			}
			const report: IterationReport = {
				summary: params.summary,
				nextAction: params.nextAction,
				blocker: params.blocker ?? null,
			};
			const recorded = await resolved.value.service.reportIteration(report);
			const text = recorded.ok
				? `iteration recorded (${recorded.value.iterations} completed)`
				: `goal: ${recorded.error}`;
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});
}

/** Normalize a tool-supplied verifier into the domain union. */
function toVerifier(input: {
	kind: "command" | "inspect";
	argv?: string[];
	pinned?: Array<{ path: string; sha256: string }>;
	expectExit?: number;
	instruction?: string;
}) {
	if (input.kind === "command") {
		return {
			kind: "command" as const,
			argv: input.argv ?? [],
			pinned: input.pinned ?? [],
			expectExit: input.expectExit ?? 0,
		};
	}
	return { kind: "inspect" as const, instruction: input.instruction ?? "" };
}

/** Dispatch one `/goal` invocation. Errors are the caller's to surface. */
async function handleCommand(
	service: GoalService,
	parsed: ParsedGoalArgs,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	switch (parsed.subcommand) {
		case "start": {
			const started = await service.start(parsed.rest);
			if (!started.ok) {
				ctx.ui.notify(`goal: ${started.error}`, "error");
				return;
			}
			const record = started.value;
			ctx.ui.notify(
				`goal ${record.id} recorded as clarifying — no worktree or branch created yet`,
				"info",
			);
			pi.sendUserMessage(
				`Clarify this goal before any code changes:\n\n${record.request}\n\n` +
					"Restate it as a measurable goal and propose acceptance criteria that are each " +
					"verifiable by a command or by inspecting harness-produced evidence. Ask at most five " +
					"focused questions. Then call goal_submit_clarification.",
				{ expandPromptTemplates: false },
			);
			return;
		}
		case "status":
			ctx.ui.notify(service.status(), "info");
			return;
		case "stop": {
			const stopped = await service.stop();
			if (!stopped.ok) {
				ctx.ui.notify(`goal: ${stopped.error}`, "error");
				return;
			}
			ctx.ui.notify(`goal stopped\n${service.status()}`, "info");
			return;
		}
		case "resume": {
			const resumed = await service.resume({ approve: parsed.flags.has("--approve") });
			if (!resumed.ok) {
				ctx.ui.notify(`goal: ${resumed.error}`, "error");
				return;
			}
			ctx.ui.notify(`goal resumed\n${service.status()}`, "info");
			return;
		}
		case "revise": {
			pi.sendUserMessage(
				"Revise the goal's acceptance criteria with the user. Criteria change only through " +
					"goal_submit_clarification; the goal returns to clarification and must be re-validated.",
				{ expandPromptTemplates: false },
			);
			ctx.ui.notify(
				"goal reopened for clarification — criteria are unchanged until resubmitted",
				"info",
			);
			return;
		}
		case "cleanup": {
			const cleaned = await service.cleanup({ confirmed: parsed.flags.has("--confirm") });
			if (!cleaned.ok) {
				ctx.ui.notify(`goal: ${cleaned.error}`, "error");
				return;
			}
			ctx.ui.notify("goal worktree removed", "info");
			return;
		}
	}
}

// ─── Production backend ──────────────────────────────────────────

/** Resolve `provider/model-id` through the shared catalog resolver. */
const catalogModelResolver: ModelResolver = (ref) => {
	const model = resolveModel(ref) as {
		id: string;
		provider: string;
		contextWindow?: number;
	};
	return {
		id: model.id,
		provider: model.provider,
		contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : 0,
	};
};

/** Goal worktrees live beside the checkout, not in `os.tmpdir()` (R3.AC2). */
function goalWorktreeBase(checkoutRoot: string): string {
	return join(checkoutRoot, "..");
}

/**
 * Build the production backend for a session context.
 *
 * GitHub is resolved lazily (see {@link LazyPullRequestPort}) so an unavailable
 * token cannot prevent goal state from being recorded — it pauses the goal when
 * a PR is required.
 */
function createDefaultBackend(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
): Result<GoalLoopBackend> {
	const checkoutRoot = ctx.cwd;
	const settingsPath = join(checkoutRoot, ".pi", "settings.json");
	const exec: ExecLike = pi.exec.bind(pi);

	const repo = readRepo(settingsPath);
	if (!repo.ok) return repo;

	const runtime = new PiGoalAgentRuntime();
	const deps: GoalServiceDeps = {
		store: new MarkdownGoalStore(checkoutRoot),
		workspace: new GitGoalWorkspace({
			checkoutRoot,
			worktreeBase: goalWorktreeBase(checkoutRoot),
			exec,
		}),
		pr: new LazyPullRequestPort(repo.value),
		runtime,
		checks: new HarnessCheckRunner({
			exec,
			inspect: createInspectRunner(ctx, settingsPath),
		}),
		loadConfig: () => prepareGoalLoopConfig({ settingsPath, resolve: catalogModelResolver }),
		notify: toNotifyFn({
			hasUI: ctx.hasUI,
			notify: (message, level) => ctx.ui.notify(message, level),
		}),
		baseBranch: () => resolveCurrentBranch(exec, checkoutRoot),
		repo: repo.value,
	};
	return { ok: true, value: { service: new GoalService(deps), runtime } };
}

/** `supervisor.repo` from the project settings — the PR target. */
function readRepo(settingsPath: string): Result<string> {
	let settings: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return failure(`${settingsPath} must contain a JSON object`, "goal-loop");
		}
		settings = parsed as Record<string, unknown>;
	} catch (err: unknown) {
		return failure(
			`cannot read ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
			"goal-loop",
		);
	}
	const supervisor = settings.supervisor;
	const repo =
		typeof supervisor === "object" && supervisor !== null
			? (supervisor as Record<string, unknown>).repo
			: undefined;
	if (typeof repo !== "string" || !repo.trim()) {
		return failure(
			`no "supervisor.repo" in ${settingsPath} — goal pull requests need a repository`,
			"goal-loop",
		);
	}
	return { ok: true, value: repo };
}

/** Nested fresh-context judgement over harness-produced evidence (R4.AC1). */
function createInspectRunner(
	ctx: ExtensionContext | ExtensionCommandContext,
	settingsPath: string,
): InspectRunner | undefined {
	const registry = ctx.modelRegistry;
	if (!registry || typeof registry.streamSimple !== "function") return undefined;

	return async (instruction, evidence) => {
		const ref = catalogGoalModel(settingsPath);
		const slash = ref.indexOf("/");
		const model = registry.find(ref.slice(0, slash), ref.slice(slash + 1));
		if (!model) throw new Error(`inspect verifier model "${ref}" is unavailable`);
		const stream = registry.streamSimple(model, {
			messages: [
				{
					role: "user",
					content: [
						"The evidence below was produced by the harness, not by the agent.",
						"Decide only from it.",
						"",
						`Criterion: ${instruction}`,
						"",
						evidence,
						"",
						'Reply with JSON only: {"pass": true|false, "note": "<short reason>"}',
					].join("\n"),
				},
			],
		} as never);

		let text = "";
		for await (const event of stream as unknown as AsyncIterable<{
			delta?: string;
			text?: string;
		}>) {
			if (typeof event.delta === "string") text += event.delta;
			else if (typeof event.text === "string") text += event.text;
		}
		const verdict = parseInspectVerdict(text);
		if (!verdict) throw new Error("inspect verifier returned no parseable verdict");
		return verdict;
	};
}

/** The configured goal model ref, read fresh from the settings file. */
function catalogGoalModel(settingsPath: string): string {
	const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
	const goalLoop = (parsed as Record<string, unknown> | null)?.goalLoop;
	const model =
		typeof goalLoop === "object" && goalLoop !== null
			? (goalLoop as Record<string, unknown>).model
			: undefined;
	if (typeof model !== "string" || !model.trim()) {
		throw new Error(`no "goalLoop.model" in ${settingsPath}`);
	}
	return model;
}

/** Parse `{"pass":bool,"note":string}` out of a model reply. */
export function parseInspectVerdict(text: string): { pass: boolean; note: string } | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (typeof record.pass !== "boolean") return undefined;
		return { pass: record.pass, note: typeof record.note === "string" ? record.note : "" };
	} catch {
		return undefined;
	}
}

/**
 * Pull-request port that connects to GitHub on first use.
 *
 * A missing token or client module becomes a failed `Result`, which pauses the
 * goal with the reason instead of aborting state recording (R3.AC5).
 */
class LazyPullRequestPort implements PullRequestPort {
	private readonly repo: string;
	private delegate: GitHubPullRequestAdapter | null = null;

	constructor(repo: string) {
		this.repo = repo;
	}

	private async resolve(): Promise<GitHubPullRequestAdapter> {
		if (this.delegate) return this.delegate;
		const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
		if (!token) {
			throw new Error("GitHub token not found — set GH_TOKEN to open goal pull requests");
		}
		const [{ Octokit }, { graphql }] = await Promise.all([
			import("@octokit/rest"),
			import("@octokit/graphql"),
		]);
		const client = {
			rest: new Octokit({ auth: token }) as unknown as OctokitLike["rest"],
			graphql: graphql.defaults({
				headers: { authorization: `token ${token}` },
			}) as unknown as OctokitLike["graphql"],
		};
		this.delegate = new GitHubPullRequestAdapter(client, this.repo);
		return this.delegate;
	}

	async openDraft(
		input: Parameters<PullRequestPort["openDraft"]>[0],
	): ReturnType<PullRequestPort["openDraft"]> {
		try {
			return await (await this.resolve()).openDraft(input);
		} catch (err: unknown) {
			return failure(err instanceof Error ? err.message : String(err), "goal-pr");
		}
	}

	async updateBody(input: {
		number: number;
		body: string;
	}): ReturnType<PullRequestPort["updateBody"]> {
		try {
			return await (await this.resolve()).updateBody(input);
		} catch (err: unknown) {
			return failure(err instanceof Error ? err.message : String(err), "goal-pr");
		}
	}

	async markReadyForReview(nodeId: string): ReturnType<PullRequestPort["markReadyForReview"]> {
		try {
			return await (await this.resolve()).markReadyForReview(nodeId);
		} catch (err: unknown) {
			return failure(err instanceof Error ? err.message : String(err), "goal-pr");
		}
	}

	async getState(number: number): ReturnType<PullRequestPort["getState"]> {
		try {
			return await (await this.resolve()).getState(number);
		} catch (err: unknown) {
			return failure(err instanceof Error ? err.message : String(err), "goal-pr");
		}
	}
}

/** Pi extension entry point. */
export default function goalLoop(pi: ExtensionAPI): void {
	registerGoalLoop(pi, {
		resolveBackend: async (ctx) => createDefaultBackend(pi, ctx),
	});
}
