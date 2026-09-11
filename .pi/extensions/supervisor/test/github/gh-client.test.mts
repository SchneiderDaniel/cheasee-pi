// ─── Tests: github/gh-client.ts — typed gh CLI wrappers ──────────
// Tests with mock pi.exec. No network calls.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn } from "../../pipeline/helpers.ts";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { gh, ghJson, ghRaw, detectTokenClass, getGitHubToken } from "../../github/gh-client.ts";

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

// ─── Tests: ghRaw() — raw CLI wrapper (headers survive) ──────────

describe("ghRaw() — raw CLI wrapper", () => {
	it("returns raw stdout including HTTP headers (no trim, no throw)", async () => {
		const calls: ExecCall[] = [];
		const header = "HTTP/2.0 200 OK\nx-oauth-scopes: repo, read:org, project\n\n{\"login\":\"octocat\"}\n";
		const exec = createMockExec({ code: 0, stdout: header, stderr: "" }, calls);
		const result = await ghRaw(exec, ["api", "-i", "/user"]);
		assert.equal(result.code, 0);
		assert.ok(result.stdout!.includes("x-oauth-scopes:"), "headers must survive");
		assert.ok(result.stdout!.includes('"login":"octocat"'), "body must survive");
		assert.equal(calls.length, 1);
	});

	it("does not throw on non-zero exit — caller decides (raw semantics)", async () => {
		const exec = createMockExec({ code: 1, stdout: "", stderr: "boom" });
		const result = await ghRaw(exec, ["api", "-i", "/user"]);
		assert.equal(result.code, 1);
	});
});

// ─── Tests: detectTokenClass() ───────────────────────────────────

describe("detectTokenClass() — remediation hint keying", () => {
	it("returns 'cheasee-pi' when auth.json holds a github_token", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-class-pi-"));
		try {
			mkdirSync(join(home, ".config", "cheasee-pi"), { recursive: true });
			writeFileSync(
				join(home, ".config", "cheasee-pi", "auth.json"),
				JSON.stringify({ github_token: "gho_init_minted", github_user: "me" }),
			);
			assert.equal(detectTokenClass(home), "cheasee-pi");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("returns 'gh' when gh hosts.yml holds an oauth_token", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-class-gh-"));
		try {
			mkdirSync(join(home, ".config", "gh"), { recursive: true });
			const yml = [
				"github.com:",
				"    users:",
				"        octocat:",
				"            oauth_token: gho_gh_minted",
				"    oauth_token: gho_gh_minted",
			].join("\n");
			writeFileSync(join(home, ".config", "gh", "hosts.yml"), yml);
			assert.equal(detectTokenClass(home), "gh");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("returns 'unknown' when neither credential store exists", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-class-unk-"));
		try {
			assert.equal(detectTokenClass(home), "unknown");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("auth.json wins over gh hosts.yml when both exist (init token re-imported into gh)", () => {
		const home = mkdtempSync(join(tmpdir(), "gh-class-both-"));
		try {
			mkdirSync(join(home, ".config", "cheasee-pi"), { recursive: true });
			writeFileSync(
				join(home, ".config", "cheasee-pi", "auth.json"),
				JSON.stringify({ github_token: "gho_init_minted" }),
			);
			mkdirSync(join(home, ".config", "gh"), { recursive: true });
			writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n    oauth_token: gho_gh_minted\n");
			assert.equal(detectTokenClass(home), "cheasee-pi", "entrypoint re-import makes gh hold the init token");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

// ─── Tests: getGitHubToken() — exported accessor ─────────────────

describe("getGitHubToken() — exported token accessor", () => {
	it("is exported and returns a string or null (cached)", () => {
		assert.equal(typeof getGitHubToken, "function");
		const token = getGitHubToken();
		assert.ok(token === null || typeof token === "string");
	});
});

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

