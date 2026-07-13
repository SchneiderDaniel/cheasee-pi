/**
 * Tests for docker/run-pi.sh and docker/stop-pi.sh — convenience
 * scripts for one-command pi session start/stop.
 *
 * Phase 1 — run-pi.sh: idempotent container start + exec (AC1-AC3)
 * Phase 2 — stop-pi.sh: one-command stop (AC4)
 *
 * Run with:
 *   node --experimental-strip-types --test docker/test/docker-convenience-scripts.test.mts
 *
 * Mocking approach:
 *   Creates a temp directory with mock `docker` scripts that
 *   log invocations to a trace file. The mock `docker ps` returns
 *   container name or nothing based on a state control file.
 *   Real scripts are run via execSync with modified PATH.
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUN_SCRIPT = resolve(__dirname, "../run-pi.sh");
const STOP_SCRIPT = resolve(__dirname, "../stop-pi.sh");
const COMPOSE_FILE = resolve(__dirname, "../docker-compose.yml");

// ═══════════════════════════════════════════════════════════════════
// Mock infrastructure
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a mock `docker` script in the given directory that logs
 * invocations to the trace file and responds to `ps` based on the
 * state file.
 */
function createMockDocker(mockDir: string, traceFile: string, stateFile: string): void {
	const content = [
		"#!/bin/bash",
		"# Mock docker — logs all invocations to trace file",
		`echo "docker $*" >> "${traceFile}"`,
		'case "${1:-}" in',
		"    ps)",
		`        if [ -f "${stateFile}" ] && [ "$(cat "${stateFile}" 2>/dev/null)" = "running" ]; then`,
		'            echo "cheasee-pi"',
		"        fi",
		"        ;;",
		"    compose|exec)",
		"        ;;",
		"    *)",
		'        echo "mock docker: unexpected command: $*" >&2',
		"        exit 1",
		"        ;;",
		"esac",
		"",
	].join("\n");
	writeFileSync(join(mockDir, "docker"), content, { mode: 0o755 });
}

/**
 * Create auth.json in the given home directory with the given
 * provider→key mapping.
 */
function createAuthJson(homeDir: string, entries: Record<string, { key: string }>): void {
	const authDir = join(homeDir, ".pi", "agent");
	mkdirSync(authDir, { recursive: true });
	writeFileSync(join(authDir, "auth.json"), JSON.stringify(entries, null, 2), "utf-8");
}

interface Fixture {
	tmpDir: string;
	mockDir: string;
	traceFile: string;
	stateFile: string;
	homeDir: string;
}

/**
 * Create a temp fixture with mock docker and a home directory.
 * Returns paths to control the test.
 */
function createFixture(): Fixture {
	const tmpDir = mkdtempSync(join(tmpdir(), "docker-conv-"));
	const mockDir = join(tmpDir, "mock");
	const homeDir = join(tmpDir, "home");
	mkdirSync(mockDir, { recursive: true });
	mkdirSync(homeDir, { recursive: true });

	const traceFile = join(tmpDir, "trace.log");
	const stateFile = join(tmpDir, "container-state");

	createMockDocker(mockDir, traceFile, stateFile);

	return { tmpDir, mockDir, traceFile, stateFile, homeDir };
}

/**
 * Read the trace file as an array of lines (empty array if absent).
 */
function readTrace(traceFile: string): string[] {
	if (!existsSync(traceFile)) return [];
	return readFileSync(traceFile, "utf-8")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/**
 * Run a script via execSync with the given options.
 * Returns { stdout, stderr, status }.
 */
function runScript(
	scriptPath: string,
	opts: {
		mockDir: string;
		homeDir: string;
		extraEnv?: Record<string, string>;
		cwd?: string;
	},
): { stdout: string; stderr: string; status: number } {
	const env: Record<string, string> = {
		...process.env as Record<string, string>,
		PATH: `${opts.mockDir}:${process.env.PATH ?? ""}`,
		HOME: opts.homeDir,
		...opts.extraEnv,
	};

	try {
		const stdout = execSync(`bash "${scriptPath}"`, {
			env,
			cwd: opts.cwd ?? opts.homeDir,
			encoding: "utf-8",
			timeout: 5000,
		});
		return { stdout: stdout.toString(), stderr: "", status: 0 };
	} catch (e: unknown) {
		const err = e as {
			status?: number;
			stdout?: string | Buffer;
			stderr?: string | Buffer;
			message?: string;
		};
		return {
			stdout: (err.stdout ?? "").toString(),
			stderr: (err.stderr ?? err.message ?? "unknown error").toString(),
			status: err.status ?? 1,
		};
	}
}

/**
 * Set the mock container state.
 */
function setContainerState(stateFile: string, state: "running" | "stopped"): void {
	writeFileSync(stateFile, state === "running" ? "running" : "", "utf-8");
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1: run-pi.sh — idempotent container start + exec
// ═══════════════════════════════════════════════════════════════════

describe("Phase 1 — run-pi.sh", () => {
	let fix: Fixture;

	beforeEach(() => {
		fix = createFixture();
	});

	afterEach(() => {
		rmSync(fix.tmpDir, { recursive: true, force: true });
	});

	it("adapter — container not running: calls up -d then exec (AC1)", () => {
		setContainerState(fix.stateFile, "stopped");

		const result = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
		});

		assert.strictEqual(result.status, 0);
		const trace = readTrace(fix.traceFile);

		// Should have both docker compose up -d and docker exec calls
		const composeUp = trace.filter((l) => l.includes("compose") && l.includes("up -d"));
		assert.ok(composeUp.length > 0, "expected docker compose up -d call");

		const execCall = trace.filter((l) => l.startsWith("docker exec"));
		assert.ok(execCall.length > 0, "expected docker exec call");
	});

	it("adapter — container already running: skips up -d, calls only exec (AC3)", () => {
		setContainerState(fix.stateFile, "running");

		const result = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
		});

		assert.strictEqual(result.status, 0);
		const trace = readTrace(fix.traceFile);

		// Should NOT have compose up -d
		const composeUp = trace.filter((l) => l.includes("compose") && l.includes("up -d"));
		assert.strictEqual(composeUp.length, 0, "expected NO docker compose up -d call");

		// Should have docker exec
		const execCall = trace.filter((l) => l.startsWith("docker exec"));
		assert.ok(execCall.length > 0, "expected docker exec call");
	});

	it("adapter — container exists but stopped: starts container then execs", () => {
		setContainerState(fix.stateFile, "stopped");

		const result = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
		});

		assert.strictEqual(result.status, 0);
		const trace = readTrace(fix.traceFile);

		// Should have compose up -d
		const composeUp = trace.filter((l) => l.includes("compose") && l.includes("up -d"));
		assert.ok(composeUp.length > 0, "expected docker compose up -d call");

		// Should have docker exec
		const execCall = trace.filter((l) => l.startsWith("docker exec"));
		assert.ok(execCall.length > 0, "expected docker exec call");
	});

	it("adapter — docker ps returns no output: script runs up -d (edge: missing container)", () => {
		// State file doesn't exist (container never created) — same as stopped
		const result = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
		});

		assert.strictEqual(result.status, 0);
		const trace = readTrace(fix.traceFile);

		const composeUp = trace.filter((l) => l.includes("compose") && l.includes("up -d"));
		assert.ok(composeUp.length > 0, "expected docker compose up -d call");

		const execCall = trace.filter((l) => l.startsWith("docker exec"));
		assert.ok(execCall.length > 0, "expected docker exec call");
	});

	it("adapter — exec command receives correct flags (AC2)", () => {
		setContainerState(fix.stateFile, "running");

		const result = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
		});

		assert.strictEqual(result.status, 0);
		const trace = readTrace(fix.traceFile);

		const execLine = trace.find((l) => l.startsWith("docker exec"));
		assert.ok(execLine, "expected docker exec call");

		assert.ok(execLine!.includes("-it"), "exec should have -it flag");
		assert.ok(execLine!.includes("--user agentuser"), "exec should have --user agentuser");
		assert.ok(
			execLine!.includes("-w /workspaces/main"),
			"exec should have -w /workspaces/main",
		);
		assert.ok(execLine!.includes("cheasee-pi"), "exec should target cheasee-pi container");
		assert.ok(execLine!.includes(" pi"), "exec command should end with pi");
	});

	it("adapter — compose file path resolves correctly from any cwd", () => {
		setContainerState(fix.stateFile, "stopped");

		// Run from a completely different directory (/tmp)
		const result = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
			cwd: tmpdir(),
		});

		assert.strictEqual(result.status, 0);
		const trace = readTrace(fix.traceFile);

		// Compose call must reference an absolute path to docker-compose.yml
		const composeLine = trace.find((l) => l.includes("compose") && l.includes("-f"));
		assert.ok(composeLine, "expected compose -f call");

		// The -f argument should be an absolute path ending in docker-compose.yml
		assert.ok(
			composeLine!.includes(COMPOSE_FILE),
			`compose -f should reference ${COMPOSE_FILE}, got: ${composeLine}`,
		);
	});

	it("adapter — stdout contains correct messages for start vs attach", () => {
		// Test 1: container not running → "Starting container" message
		setContainerState(fix.stateFile, "stopped");
		const result1 = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
		});
		assert.ok(
			result1.stdout.includes("Starting container"),
			`expected "Starting container" in stdout, got: ${result1.stdout}`,
		);

		// Test 2: container running → "Container already running" message
		setContainerState(fix.stateFile, "running");
		const result2 = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
		});
		assert.ok(
			result2.stdout.includes("Container already running"),
			`expected "Container already running" in stdout, got: ${result2.stdout}`,
		);
	});

	it("adapter — docker not found: exits non-zero (via set -e)", () => {
		// Remove mock dir from PATH entirely — docker won't be found
		const result = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
			extraEnv: { PATH: "/usr/bin:/bin" }, // no mock docker in path
		});

		assert.notStrictEqual(result.status, 0, "expected non-zero exit when docker not found");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 1b: run-pi.sh — env var passthrough from auth.json and gh
// ═══════════════════════════════════════════════════════════════════

describe("Phase 1b — run-pi.sh env var passthrough", () => {
	let fix: Fixture;

	beforeEach(() => {
		fix = createFixture();
		setContainerState(fix.stateFile, "running");
	});

	afterEach(() => {
		rmSync(fix.tmpDir, { recursive: true, force: true });
	});

	it("passes API keys from auth.json as -e flags to docker exec", () => {
		createAuthJson(fix.homeDir, {
			opencode: { key: "oc-key-123" },
			openai: { key: "oa-key-456" },
		});

		const result = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
		});

		assert.strictEqual(result.status, 0);
		const trace = readTrace(fix.traceFile);
		const execLine = trace.find((l) => l.startsWith("docker exec"));

		assert.ok(execLine, "expected docker exec call");
		assert.ok(
			execLine!.includes("-e OPENCODE_API_KEY=oc-key-123"),
			"should pass OPENCODE_API_KEY",
		);
		assert.ok(
			execLine!.includes("-e OPENAI_API_KEY=oa-key-456"),
			"should pass OPENAI_API_KEY",
		);
	});

	it("passes GH_TOKEN from env to docker exec", () => {
		const result = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
			extraEnv: { GH_TOKEN: "ghp_test-token-xyz" },
		});

		assert.strictEqual(result.status, 0);
		const trace = readTrace(fix.traceFile);
		const execLine = trace.find((l) => l.startsWith("docker exec"));

		assert.ok(execLine, "expected docker exec call");
		assert.ok(
			execLine!.includes("-e GH_TOKEN=ghp_test-token-xyz"),
			"should pass GH_TOKEN from env",
		);
	});

	it("skips auth.json block gracefully when file does not exist", () => {
		// No auth.json created — script should not error
		const result = runScript(RUN_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
		});

		assert.strictEqual(result.status, 0);
		const trace = readTrace(fix.traceFile);
		const execLine = trace.find((l) => l.startsWith("docker exec"));
		assert.ok(execLine, "expected docker exec call");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2: stop-pi.sh — one-command stop
// ═══════════════════════════════════════════════════════════════════

describe("Phase 2 — stop-pi.sh", () => {
	let fix: Fixture;

	beforeEach(() => {
		fix = createFixture();
	});

	afterEach(() => {
		rmSync(fix.tmpDir, { recursive: true, force: true });
	});

	it("adapter — calls docker compose down (AC4)", () => {
		const result = runScript(STOP_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
		});

		assert.strictEqual(result.status, 0);
		const trace = readTrace(fix.traceFile);

		const composeDown = trace.filter((l) => l.includes("compose") && l.includes("down"));
		assert.ok(composeDown.length > 0, "expected docker compose down call");
	});

	it("adapter — docker compose not found: exits non-zero (via set -e)", () => {
		const result = runScript(STOP_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
			extraEnv: { PATH: "/usr/bin:/bin" }, // no mock docker in path
		});

		assert.notStrictEqual(result.status, 0, "expected non-zero exit when docker not found");
	});

	it("adapter — emits stopping message to stdout", () => {
		const result = runScript(STOP_SCRIPT, {
			mockDir: fix.mockDir,
			homeDir: fix.homeDir,
		});

		assert.strictEqual(result.status, 0);
		assert.ok(
			result.stdout.includes("Stopping container"),
			`expected "Stopping container" in stdout, got: ${result.stdout}`,
		);
	});
});
