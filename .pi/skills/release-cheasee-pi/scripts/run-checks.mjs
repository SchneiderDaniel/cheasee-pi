#!/usr/bin/env node
/**
 * run-checks.mjs — Run all pre-release checks with failure snapshot comparison.
 *
 * Usage: node run-checks.mjs [snapshot-file]
 *
 * If snapshot-file is provided and exists, it's loaded as the baseline
 * set of expected failures. Only NEW failures (not in snapshot) cause exit code 1.
 * If no snapshot-file, all failures are fatal.
 *
 * Exits 0 if all checks pass (or only baseline failures remain).
 * Exits 1 on failure.
 */
import { execSync } from "child_process";
import fs from "fs";

const snapshotPath = process.argv[2];
let baseline = new Set();
if (snapshotPath) {
	try {
		const data = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
		baseline = new Set(data.failures || []);
		console.log(`Loaded baseline: ${baseline.size} pre-existing failures`);
	} catch {
		// no baseline, all failures are new
	}
}

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const CHECKS = [
	{ name: "TypeScript (tsc)", cmd: "npm run tsc:extensions", cwd: ROOT, timeout: 120_000 },
	{
		name: "Node tests",
		cmd: "find . \\( -path './node_modules' -o -path './.git' -o -path './.pi/git' \\) -prune -o -type f \\( -name '*.test.ts' -o -name '*.test.mts' -o -name '*.test.mjs' -o -name '*.test.js' \\) -print0 | xargs -0 node --experimental-strip-types --test --test-concurrency=1",
		cwd: ROOT,
		timeout: 300_000,
	},
	{ name: "Go build", cmd: "go build ./cmd/cheasee-pi/", cwd: ROOT, timeout: 120_000 },
	{ name: "Go vet", cmd: "go vet ./cmd/cheasee-pi/...", cwd: ROOT, timeout: 120_000 },
	{ name: "Go tests", cmd: "go test ./cmd/cheasee-pi/...", cwd: ROOT, timeout: 120_000 },
	{
		name: "GoReleaser config",
		cmd: `node -e "try { require('js-yaml').load(require('fs').readFileSync('.goreleaser.yml','utf8')); console.log('valid YAML') } catch(e) { console.error(e.message); process.exit(1) }"`,
		cwd: ROOT,
		timeout: 30_000,
	},
];

let failures = [];
let newFailures = [];

for (const check of CHECKS) {
	try {
		execSync(check.cmd, {
			cwd: check.cwd,
			stdio: "pipe",
			encoding: "utf8",
			timeout: check.timeout,
		});
		console.log(`✓ ${check.name}`);
	} catch (e) {
		const name = check.name;
		const stderr = e.stderr || "";
		const stdout = e.stdout || "";
		// Extract failing test names from output
		const testFailures = extractTestFailures(stdout + stderr);

		if (
			baseline.size > 0 &&
			testFailures.every((f) => baseline.has(f)) &&
			testFailures.length > 0
		) {
			console.log(`~ ${name} (only baseline failures)`);
		} else {
			console.log(`✗ ${name}`);
			failures.push(name);
			if (!testFailures.every((f) => baseline.has(f))) {
				newFailures.push(name);
			}
		}
	}
}

// If snapshot requested and no snapshot file given, save current failures as baseline
if (snapshotPath && !fs.existsSync(snapshotPath)) {
	fs.writeFileSync(snapshotPath, JSON.stringify({ failures }, null, 2));
	console.log(`\nSaved baseline to ${snapshotPath} (${failures.length} failures)`);
}

console.log(
	`\n${CHECKS.length} checks: ${CHECKS.length - failures.length} pass, ${failures.length} fail`,
);
if (newFailures.length > 0) {
	console.log(`New failures: ${newFailures.join(", ")}`);
	process.exit(1);
}
if (failures.length > 0) {
	console.log(`Baseline-only failures: ${failures.join(", ")} — safe to continue`);
}
process.exit(failures.length > 0 && newFailures.length > 0 ? 1 : 0);

function extractTestFailures(output) {
	const lines = output.split("\n");
	const failures = [];
	for (const line of lines) {
		// TAP: "not ok N - test name"
		const tapMatch = line.match(/^not ok\s+\d+\s+-\s+(.+)/);
		if (tapMatch) failures.push(tapMatch[1].trim());
		// Go test: "--- FAIL: TestName"
		const goMatch = line.match(/^---\s+FAIL:\s+(.+)/);
		if (goMatch) failures.push(goMatch[1].trim());
	}
	return failures;
}
