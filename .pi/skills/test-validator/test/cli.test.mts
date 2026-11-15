// Phase 8a — CLI preconditions: the API key, `gh auth`, `supervisor.repo`, and
// inventory discovery must fail before the first model call.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	DEFAULT_CONFIG,
	checkpointPath,
	ghCalls,
	reportPath,
	runCli,
	withRepo,
} from "./support/cli-fixture.mts";

describe("cli: preconditions fail before the first model call", () => {
	it("halts when the provider API key is missing", async () => {
		await withRepo({ config: { ...DEFAULT_CONFIG, model: "gpt-4" } }, async (repo) => {
			const result = runCli(repo, ["--config", "config.json"], {
				OPENAI_API_KEY: undefined,
				FAUX_MODE: "good",
			});

			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /openai/i);
			assert.match(result.stderr, /OPENAI_API_KEY/);
			assert.equal(existsSync(checkpointPath(repo)), false, "no checkpoint line is written");
		});
	});

	it("halts when gh is not authenticated", async () => {
		await withRepo({}, async (repo) => {
			const result = runCli(repo, ["--config", "config.json"], {
				GH_FAIL_AUTH: "1",
				FAUX_MODE: "good",
			});

			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /not logged in|auth/i);
			assert.equal(existsSync(checkpointPath(repo)), false);
		});
	});

	it("halts when supervisor.repo is not configured", async () => {
		await withRepo({ settings: { supervisor: {} } }, async (repo) => {
			const result = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "good" });

			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /supervisor\.repo/);
			assert.equal(result.stderr.includes("github.com/o/r"), false, "no git-remote fallback");
			assert.equal(existsSync(reportPath(repo)), false);
		});
	});

	it("halts on an unresolvable test file, naming file and line", async () => {
		await withRepo(
			{ tests: ['import { it } from "node:test";', 'it("broken", () => {'].join("\n") },
			async (repo) => {
				const result = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "good" });

				assert.notEqual(result.status, 0);
				assert.match(result.stderr, /src\/a\.test\.mts/);
				assert.match(result.stderr, /src\/a\.test\.mts:\d+/);
				assert.equal(existsSync(reportPath(repo)), false);
				assert.equal(
					ghCalls(repo).some((argv) => argv[0] === "issue" && argv[1] === "create"),
					false,
				);
			},
		);
	});

	it("prints usage for --help without writing anything", async () => {
		await withRepo({}, async (repo) => {
			const result = runCli(repo, ["--help"], { FAUX_MODE: "good" });

			assert.equal(result.status, 0);
			assert.match(result.stdout, /test-validator/);
			assert.match(result.stdout, /--restart/);
			assert.equal(existsSync(checkpointPath(repo)), false);
			assert.equal(existsSync(reportPath(repo)), false);
			assert.deepEqual(ghCalls(repo), []);
		});
	});
});
