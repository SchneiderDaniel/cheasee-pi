// ─── Tests: github/gh-client.ts — typed gh CLI wrappers ──────────
// Tests with mock pi.exec. No network calls.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExecFn } from "../../pipeline/helpers.ts";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { gh, ghJson, ghGraphQL } from "../../github/gh-client.ts";
import type { ProjectItemsResponse } from "../../github/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockExec(
	execResult: { code: number; stdout: string; stderr: string },
	calls?: ExecCall[],
): ExecFn {
	const callLog = calls || [];
	return async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
		callLog.push({ cmd, args: args || [], opts: (opts || {}) as Record<string, unknown> });
		return { ...execResult, killed: false };
	};
}

// ─── Tests: gh() ──────────────────────────────────────────────────

describe("gh() — low-level CLI wrapper", () => {
	it("calls pi.exec with correct args and returns trimmed stdout on code 0", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec({ code: 0, stdout: "hello world\n", stderr: "" }, calls);
		const result = await gh(exec, ["issue", "view", "123"]);
		assert.equal(result, "hello world");
		assert.equal(calls.length, 1);
		// gh() may call through bash for GH_TOKEN injection or gh directly
		const cmd = calls[0].cmd;
		assert.ok(cmd === "bash" || cmd === "gh", `cmd should be bash or gh, got: ${cmd}`);
		if (cmd === "bash") {
			// Through bash: args[0]='-c', args[1] contains gh command, args[2]='_', then original args
			const ghArgs = calls[0].args.slice(3);
			assert.deepEqual(ghArgs, ["issue", "view", "123"]);
		} else {
			assert.deepEqual(calls[0].args, ["issue", "view", "123"]);
		}
		assert.ok(calls[0].opts);
	});

	it("throws on non-zero exit, includes stderr then stdout fallback", async () => {
		const exec = createMockExec({ code: 1, stdout: "", stderr: "auth failed" });
		await assert.rejects(() => gh(exec, ["issue", "view", "123"]), /gh issue failed: auth failed/);
	});

	it("uses stderr when stderr is empty, falls back to stdout in error message", async () => {
		const exec = createMockExec({ code: 1, stdout: "unknown command", stderr: "" });
		await assert.rejects(() => gh(exec, ["issue", "view"]), /gh issue failed: unknown command/);
	});

	it("passes opts.signal and opts.timeout through to pi.exec", async () => {
		const calls: ExecCall[] = [];
		const controller = new AbortController();
		const exec = createMockExec({ code: 0, stdout: "ok", stderr: "" }, calls);
		await gh(exec, ["status"], { signal: controller.signal, timeout: 5000 });
		// The opts are passed to exec regardless of bash/gh path
		assert.equal(calls[0].opts.signal, controller.signal);
		assert.equal(calls[0].opts.timeout, 5000);
	});
});

// ─── Tests: ghJson<T>() ───────────────────────────────────────────

describe("ghJson<T>() — typed JSON output parser", () => {
	it("calls gh() and parses JSON output into typed result", async () => {
		const data = { number: 123, title: "Test" };
		const exec = createMockExec({ code: 0, stdout: JSON.stringify(data), stderr: "" });
		const result = await ghJson<{ number: number; title: string }>(exec, [
			"issue",
			"view",
			"123",
			"--json",
			"number,title",
		]);
		assert.deepEqual(result, data);
	});

	it("returns null when gh() returns empty string", async () => {
		const exec = createMockExec({ code: 0, stdout: "", stderr: "" });
		const result = await ghJson(exec, ["issue", "view", "999"]);
		assert.equal(result, null);
	});

	it("throws when output is invalid JSON", async () => {
		const exec = createMockExec({ code: 0, stdout: "not json", stderr: "" });
		await assert.rejects(() => ghJson(exec, ["issue", "view"]), SyntaxError);
	});

	it("generic type parameter compiles correctly", async () => {
		const exec = createMockExec({ code: 0, stdout: '{"id":"PVT_1"}', stderr: "" });
		const result = await ghJson<{ id: string }>(exec, ["project", "view"]);
		assert.ok(result !== null);
		assert.equal(result!.id, "PVT_1");
	});
});

// ─── Tests: ghGraphQL<T>() ────────────────────────────────────────

describe("ghGraphQL<T>() — typed GraphQL wrapper", () => {
	it("passes query arg with -f query= correctly", async () => {
		const calls: ExecCall[] = [];
		const exec = createMockExec(
			{ code: 0, stdout: '{"data":{"viewer":{"login":"test"}}}', stderr: "" },
			calls,
		);
		await ghGraphQL(exec, "{ viewer { login } }");
		const args = calls[0].args;
		assert.ok(args.includes("-f"));
		const queryIdx = args.indexOf("-f");
		assert.ok(queryIdx >= 0);
		assert.equal(args[queryIdx + 1], "query={ viewer { login } }");
	});

	it("returns typed result for valid GraphQL response JSON", async () => {
		const response = { data: { viewer: { login: "testuser" } } };
		const exec = createMockExec({ code: 0, stdout: JSON.stringify(response), stderr: "" });
		const result = await ghGraphQL<{ data: { viewer: { login: string } } }>(
			exec,
			"{ viewer { login } }",
		);
		assert.ok(result !== null);
		assert.equal(result.data.viewer.login, "testuser");
	});

	it("ghGraphQL<ProjectItemsResponse>(...) return type assignment compiles without as any", async () => {
		const response = {
			data: {
				viewer: {
					projectV2: {
						items: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [],
						},
					},
				},
			},
		};
		const exec = createMockExec({ code: 0, stdout: JSON.stringify(response), stderr: "" });
		const result: ProjectItemsResponse | null = await ghGraphQL<ProjectItemsResponse>(
			exec,
			"{ viewer { projectV2 { items { pageInfo { hasNextPage endCursor } nodes { id } } } } }",
		);
		assert.ok(result !== null);
		assert.equal(result.data?.viewer?.projectV2?.items?.pageInfo.hasNextPage, false);
	});
});
