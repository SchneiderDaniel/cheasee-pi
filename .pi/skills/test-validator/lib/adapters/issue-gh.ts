// Adapter: the only file in this skill that shells out to `gh`.
//
// Two operations, both argv arrays through `spawnArgv` (never a shell): create
// one issue from a body *file* (so backticks, `$()`, and quotes survive
// verbatim), and search for an issue by its run marker so an interrupted run
// never files twice. Errors carry the exit code and stderr; nothing is parsed
// into a partial URL.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { spawnArgv } from "../../../../extensions/lib/safe-argv.ts";
import type { IssueFiler, IssueRecord } from "../ports.ts";
import { issueMarker, MAX_ISSUE_BODY_BYTES } from "../report.ts";

/** A `gh` invocation failed (non-zero exit, missing binary, spawn error). */
export class GhCommandError extends Error {
	readonly code = "GH_COMMAND_FAILED";
	/** Exit code when the binary ran and exited non-zero; null otherwise. */
	readonly exitCode: number | null;
	constructor(message: string, exitCode: number | null, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "GhCommandError";
		this.exitCode = exitCode;
	}
}

/** Result of one child-process run. */
interface GhCommandResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Injectable spawn seam (tests substitute a recorder). */
export type GhSpawn = (
	program: string,
	args: string[],
	options: { readonly cwd?: string },
) => Promise<GhCommandResult>;

/**
 * Default spawn: argv array, `shell:false`, stdout/stderr captured. Spawn
 * failures (a missing binary) are surfaced as thrown errors so the caller maps
 * them to a halt, never to a per-test pending.
 */
const childProcessSpawn: GhSpawn = (program, args, options) =>
	new Promise<GhCommandResult>((resolve, reject) => {
		const child = spawnArgv(
			(cmd: string, argv: string[], opts: object) =>
				spawn(cmd, argv, { ...opts, stdio: ["ignore", "pipe", "pipe"] }),
			program,
			args,
			options,
		) as ReturnType<typeof spawn>;
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => reject(err));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});

/** Outcome of the `gh auth status` precondition. */
interface GhAuthState {
	readonly ok: boolean;
	readonly message: string;
}

/** Startup precondition: without authenticated `gh`, filing would fail late. */
export async function checkGhAuth(runGh: GhSpawn = childProcessSpawn): Promise<GhAuthState> {
	try {
		const result = await runGh("gh", ["auth", "status"], {});
		if (result.code === 0) return { ok: true, message: "gh is authenticated" };
		return {
			ok: false,
			message: `gh auth status failed (exit ${result.code}): ${result.stderr.trim() || "run \`gh auth login\`"}`,
		};
	} catch (err) {
		return {
			ok: false,
			message: `gh is not runnable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

interface GhIssueFilerOptions {
	/** `owner/repo`, from `.pi/settings.json` `supervisor.repo`. */
	readonly repo: string;
	/** Directory for the temporary body file (inside the repo's `ignore/`). */
	readonly bodyDir: string;
	readonly spawn?: GhSpawn;
}

function firstUrl(stdout: string): string | null {
	const match = stdout.match(/https?:\/\/\S+/);
	return match === null ? null : match[0];
}

interface ListedIssue {
	readonly url?: unknown;
	readonly body?: unknown;
}

/**
 * Create the `gh` issue filer. Both operations are argv-only, so a title or a
 * body can contain any character without being interpreted.
 */
export function createGhIssueFiler(options: GhIssueFilerOptions): IssueFiler {
	const runGh = options.spawn ?? childProcessSpawn;

	const run = async (args: readonly string[], what: string): Promise<string> => {
		let result: GhCommandResult;
		try {
			result = await runGh("gh", [...args], {});
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			const hint = code === "ENOENT" ? "gh binary not found on PATH" : "gh could not be started";
			throw new GhCommandError(
				`${hint}: ${err instanceof Error ? err.message : String(err)}`,
				null,
				{
					cause: err,
				},
			);
		}
		if (result.code !== 0) {
			throw new GhCommandError(
				`${what} failed (gh exit ${result.code}): ${result.stderr.trim() || "no stderr"}`,
				result.code,
			);
		}
		return result.stdout;
	};

	return {
		async create(input: {
			readonly title: string;
			readonly body: string;
		}): Promise<{ url: string }> {
			mkdirSync(options.bodyDir, { recursive: true });
			const dir = mkdtempSync(join(options.bodyDir, "issue-"));
			const bodyPath = join(dir, "body.md");
			try {
				writeFileSync(bodyPath, input.body, "utf8");
				const stdout = await run(
					[
						"issue",
						"create",
						"--repo",
						options.repo,
						"--title",
						input.title,
						"--body-file",
						bodyPath,
					],
					"gh issue create",
				);
				const url = firstUrl(stdout);
				if (url === null) {
					throw new GhCommandError(
						`gh issue create reported success but printed no issue URL: ${stdout.trim() || "(empty stdout)"}`,
						null,
					);
				}
				return { url };
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},

		async search(input: { readonly runFingerprint: string }): Promise<IssueRecord | null> {
			const marker = issueMarker(input.runFingerprint);
			if (new TextEncoder().encode(marker).length > MAX_ISSUE_BODY_BYTES) {
				throw new GhCommandError("run marker is implausibly large; refusing to search", null);
			}
			const stdout = await run(
				[
					"issue",
					"list",
					"--repo",
					options.repo,
					"--state",
					"all",
					"--search",
					`"test-validator-run:${input.runFingerprint}" in:body`,
					"--json",
					"url,body",
					"--limit",
					"20",
				],
				"gh issue list",
			);
			let listed: unknown;
			try {
				listed = JSON.parse(stdout);
			} catch {
				throw new GhCommandError(
					`gh issue list returned unparsable JSON: ${stdout.slice(0, 200)}`,
					null,
				);
			}
			if (!Array.isArray(listed)) {
				throw new GhCommandError("gh issue list returned no JSON array", null);
			}
			for (const item of listed as ListedIssue[]) {
				if (typeof item.url !== "string" || typeof item.body !== "string") continue;
				if (item.body.includes(marker)) {
					return { runFingerprint: input.runFingerprint, url: item.url };
				}
			}
			return null;
		},
	};
}

/** Temp root that keeps issue bodies inside a gitignored directory. */
export function defaultBodyDir(cwd: string): string {
	return join(cwd, "ignore", "test-validator", "issue-bodies");
}
