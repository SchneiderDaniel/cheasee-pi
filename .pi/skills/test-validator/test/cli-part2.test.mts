// Phase 8b — completed CLI audits: report on disk, one issue, resume, restart,
// and no credential on disk.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	DEFAULT_CONFIG,
	checkpointPath,
	ghCalls,
	reportPath,
	runCli,
	withRepo,
} from "./support/cli-fixture.mts";

describe("cli: completed audits", () => {
	it("judges two tests, writes the report, and files exactly one issue", async () => {
		await withRepo({}, async (repo) => {
			const result = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "bad" });

			assert.equal(result.status, 0, result.stderr);
			assert.match(
				result.stdout,
				/counts: 2 judged \(0 GOOD, 2 BAD, 0 pending\), 0 excluded, 0 reused/,
			);
			assert.match(result.stdout, /report: ignore\/test-validator\/report\.json/);
			assert.match(result.stdout, /issue: https:\/\/github\.com\/o\/r\/issues\/42/);

			const report = JSON.parse(readFileSync(reportPath(repo), "utf8"));
			assert.equal(report.counts.discovered, 2);
			assert.equal(report.counts.bad, 2);
			assert.equal(report.issue.url, "https://github.com/o/r/issues/42");
			assert.equal(typeof report.runFingerprint, "string");
			assert.equal(report.tests.length, 2);

			const creates = ghCalls(repo).filter((argv) => argv[0] === "issue" && argv[1] === "create");
			assert.equal(creates.length, 1);
			assert.deepEqual(creates[0].slice(0, 6), [
				"issue",
				"create",
				"--repo",
				"o/r",
				"--title",
				"Test quality review: 2 BAD tests",
			]);
			const body = readFileSync(`${repo.ghLog}.body`, "utf8");
			assert.match(body, /a\.test\.mts:\d+-\d+/);
			assert.match(body, /keeps the total/);
			assert.match(body, /rejects negatives/);
		});
	});

	it("writes a report and files nothing when every test is GOOD", async () => {
		await withRepo({}, async (repo) => {
			const result = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "good" });

			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /0 BAD/);
			assert.match(result.stdout, /issue: none \(no BAD tests\)/);
			assert.equal(existsSync(reportPath(repo)), true);
			assert.equal(
				ghCalls(repo).some((argv) => argv[0] === "issue" && argv[1] === "create"),
				false,
			);
		});
	});

	it("reports an incomplete run with exit 3 and no artifacts", async () => {
		await withRepo({}, async (repo) => {
			const result = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "pending" });

			assert.equal(result.status, 3, result.stderr);
			assert.match(result.stdout, /2 pending/);
			assert.match(result.stdout, /report: none \(incomplete run\)/);
			assert.equal(existsSync(reportPath(repo)), false);
			assert.equal(
				ghCalls(repo).some((argv) => argv[0] === "issue" && argv[1] === "create"),
				false,
			);
		});
	});

	it("resumes a completed checkpoint and archives it on --restart", async () => {
		await withRepo({}, async (repo) => {
			const first = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "good" });
			assert.equal(first.status, 0, first.stderr);
			const before = readFileSync(checkpointPath(repo), "utf8");
			assert.ok(before.includes('"type":"verdict"'));

			const resumed = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "good" });
			assert.equal(resumed.status, 0, resumed.stderr);
			assert.match(resumed.stdout, /2 reused/);

			const restarted = runCli(repo, ["--config", "config.json", "--restart"], {
				FAUX_MODE: "good",
			});
			assert.equal(restarted.status, 0, restarted.stderr);
			assert.match(restarted.stdout, /0 reused/);

			const archiveDir = join(repo.dir, "ignore", "test-validator", "archive");
			assert.equal(existsSync(archiveDir), true);
			const archived = readdirSync(archiveDir);
			assert.equal(archived.length, 1);
			assert.equal(readFileSync(join(archiveDir, archived[0]), "utf8"), before);
			const header = JSON.parse(readFileSync(checkpointPath(repo), "utf8").split("\n")[0]);
			assert.equal(header.type, "header");
		});
	});

	it("truncates the inventory in pilot mode and warns about the checkpoint", async () => {
		await withRepo({}, async (repo) => {
			const result = runCli(repo, ["--config", "config.json", "--limit", "1"], {
				FAUX_MODE: "good",
			});

			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /counts: 1 judged/);
			assert.match(result.stderr, /pilot mode/);
			assert.match(result.stderr, /--restart/);
			assert.equal(JSON.parse(readFileSync(reportPath(repo), "utf8")).counts.discovered, 1);
		});
	});

	it("keeps the API key out of the config and the checkpoint", async () => {
		await withRepo({}, async (repo) => {
			const result = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "good" });
			assert.equal(result.status, 0, result.stderr);

			const secret = "sk-test-secret";
			assert.equal(readFileSync(join(repo.dir, "config.json"), "utf8").includes(secret), false);
			assert.equal(readFileSync(checkpointPath(repo), "utf8").includes(secret), false);
			assert.equal(readFileSync(reportPath(repo), "utf8").includes(secret), false);
		});
	});

	it("halts on a tampered checkpoint instead of completing the audit", async () => {
		await withRepo({ config: { ...DEFAULT_CONFIG, maxAttempts: 1 } }, async (repo) => {
			const first = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "bad" });
			assert.equal(first.status, 0, first.stderr);
			assert.match(first.stdout, /issue: https:/);
			rmSync(reportPath(repo));

			// One hand-edited decision must never be replayed as a completed audit.
			const lines = readFileSync(checkpointPath(repo), "utf8").split("\n");
			const verdictIndex = lines.findIndex((line) => line.includes('"type":"verdict"'));
			assert.ok(verdictIndex > 0);
			lines[verdictIndex] = JSON.stringify({
				...JSON.parse(lines[verdictIndex]),
				decision: "BOGUS",
			});
			writeFileSync(checkpointPath(repo), lines.join("\n"), "utf8");

			const second = runCli(repo, ["--config", "config.json"], { FAUX_MODE: "good" });

			assert.notEqual(second.status, 0);
			assert.match(second.stderr, /invalid checkpoint record/);
			assert.match(second.stderr, /decision/);
			assert.equal(existsSync(reportPath(repo)), false, "no report from a tampered checkpoint");
			assert.equal(
				ghCalls(repo).filter((argv) => argv[0] === "issue" && argv[1] === "create").length,
				1,
				"the first run's issue is not filed twice",
			);
		});
	});
});
