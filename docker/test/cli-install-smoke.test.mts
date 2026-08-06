/**
 * CLI installation smoke test (DinD, full user flow).
 *
 * Simulates a real user's machine:
 *   1. Download cheasee-pi binary (pre-built by workflow)
 *   2. git config --global (avoids prompts in scaffold)
 *   3. cheasee-pi init --no-github ... (all flags to skip interactivity)
 *   4. Verify generated files (checkpoint 3)
 *   5. docker compose build (checkpoint 4)
 *   6. docker compose up -d (checkpoint 5)
 *   7. Health check reaches healthy (checkpoint 6)
 *   8. pi --version inside container (checkpoint 7)
 *
 * Run with:
 *   CHEASEE_PI_BIN=/path/to/cheasee-pi \
 *     node --experimental-strip-types --test docker/test/cli-install-smoke.test.mts
 *
 * Workflow sets CHEASEE_PI_BIN and DOCKER_HOST for DinD.
 */

import assert from "node:assert";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";

// Redirect auth.json to a test-only location so `init` subprocesses
// don't clobber the real ~/.config/cheasee-pi/auth.json on the host.
const testXdgHome = mkdtempSync(join(tmpdir(), "cheasee-pi-test-xdg-"));
process.env.XDG_CONFIG_HOME = testXdgHome;
process.on("exit", () => {
	try {
		rmSync(testXdgHome, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

// ═══════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════

const BINARY_PATH = process.env.CHEASEE_PI_BIN ?? resolve(process.cwd(), "cheasee-pi");
const CONTAINER_NAME = "cheasee-pi";
const HEALTH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;

/**
 * Compute the compose file path relative to a workdir.
 * The compose file is at <workdir>/docker/docker-compose.yml after init.
 */
function composeFile(workdir: string): string {
	return join(workdir, "docker", "docker-compose.yml");
}

interface ExecResult {
	stdout: string;
	stderr: string;
	status: number;
}

/**
 * Run a command via spawnSync with timeout and string encoding.
 * Always returns { stdout, stderr, status } — never throws.
 * Uses spawnSync (not execSync) so stderr is captured on both
 * success and failure paths.
 */
function exec(
	cmd: string,
	opts?: { timeout?: number; cwd?: string; env?: Record<string, string> },
): ExecResult {
	const defaultTimeout = opts?.timeout ?? 30_000;
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		...opts?.env,
	};
	const spawnOpts: SpawnSyncOptionsWithStringEncoding = {
		encoding: "utf-8",
		timeout: defaultTimeout,
		cwd: opts?.cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"] as const,
		shell: true,
	};
	const result = spawnSync(cmd, spawnOpts);
	return {
		stdout: (result.stdout ?? "").toString(),
		stderr: (result.stderr ?? "").toString(),
		status: result.status ?? 1,
	};
}

/**
 * Check whether the cheasee-pi binary exists at BINARY_PATH.
 */
function binaryExists(): boolean {
	return existsSync(BINARY_PATH);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `docker inspect --format='{{.State.Health.Status}}'` until
 * the container reports "healthy" or timeout elapses.
 */
async function waitForHealthy(timeoutMs: number): Promise<string> {
	const startTime = Date.now();
	const deadline = startTime + timeoutMs;
	while (Date.now() < deadline) {
		const result = exec(`docker inspect --format='{{.State.Health.Status}}' ${CONTAINER_NAME}`, {
			timeout: 10_000,
		});
		if (result.status === 0) {
			const status = result.stdout.trim();
			if (status === "healthy") return status;
			if (status === "unhealthy") return status; // terminal failure
		}
		// Exponential backoff: start at 2s, cap at 10s
		const elapsed = Date.now() - startTime;
		const delay = Math.min(2000 + elapsed * 0.5, POLL_INTERVAL_MS);
		await sleep(delay);
	}
	return "timeout";
}

// ═══════════════════════════════════════════════════════════════════
// Smoke test — full user flow (checkpoints 1-7)
// ═══════════════════════════════════════════════════════════════════

describe("CLI install smoke", { timeout: 600_000 }, () => {
	let workdir: string;

	before(() => {
		// Verify binary exists before starting
		if (!binaryExists()) {
			throw new Error(
				`cheasee-pi binary not found at ${BINARY_PATH}. ` +
					"Set CHEASEE_PI_BIN env var or place the binary in the cwd.",
			);
		}

		// Create a fresh temp directory for the test
		workdir = mkdtempSync(join(tmpdir(), "cli-install-"));
	});

	after(() => {
		// Clean up: compose down if container is running
		if (workdir) {
			exec(`docker compose -f "${composeFile(workdir)}" down -v 2>/dev/null || true`, {
				timeout: 30_000,
			});
			// Remove temp directory
			rmSync(workdir, { recursive: true, force: true });
		}
	});

	// ── Checkpoint 1: binary runs and reports version ──────────────

	it("checkpoint 1 — cheasee-pi --version exits 0", () => {
		const result = exec(`"${BINARY_PATH}" --version`, { timeout: 10_000 });
		assert.strictEqual(result.status, 0, `--version exited ${result.status}: ${result.stderr}`);
		// Should contain something like "0.31.0" or "0.33"
		const output = result.stdout.trim();
		assert.ok(
			/\d+\.\d+(\.\d+)?/.test(output),
			`expected semver in --version output, got: ${output}`,
		);
	});

	// ── Checkpoint 2: init succeeds with all non-interactive flags ──

	it("checkpoint 2 — cheasee-pi init exits 0", () => {
		const result = exec(
			`"${BINARY_PATH}" init ` +
				"--no-github " +
				"--skip-fork " +
				"--skip-submodules " +
				"--no-input " +
				"--no-docker-check " +
				"--api-key ci-test-key " +
				"--provider opencode-go " +
				`--workdir "${workdir}"`,
			{ timeout: 60_000 },
		);
		assert.strictEqual(result.status, 0, `init exited ${result.status}: ${result.stderr}`);
		assert.ok(
			result.stderr.includes("Init complete!"),
			`expected "Init complete!" in stderr, got: ${result.stderr}`,
		);
	});

	// ── Checkpoint 3: all 8 generated files exist ──────────────────

	it("checkpoint 3 — all generated files exist and are non-empty", () => {
		const files = [
			"docker/Dockerfile",
			"docker/docker-compose.yml",
			"docker/entrypoint.sh",
			"docker/run-pi.sh",
			"docker/stop-pi.sh",
			"docker/lib/auth-env.sh",
			"docker/.env",
			".pi/settings.json",
		];
		for (const f of files) {
			const fullPath = join(workdir, f);
			assert.ok(existsSync(fullPath), `expected file to exist: ${f} (${fullPath})`);
			const content = readFileSync(fullPath, "utf-8");
			assert.ok(content.length > 0, `expected non-empty file: ${f}`);
		}
	});

	// ── Checkpoint 4: docker compose build ─────────────────────────

	it("checkpoint 4 — docker compose build exits 0", () => {
		const result = exec(
			`docker compose -f "${composeFile(workdir)}" build`,
			{ timeout: 600_000, cwd: workdir }, // 10 min — cold build is slow
		);
		assert.strictEqual(result.status, 0, `compose build exited ${result.status}: ${result.stderr}`);
	});

	// ── Checkpoint 5: docker compose up -d ─────────────────────────

	it("checkpoint 5 — docker compose up -d exits 0, container running", () => {
		// Start only the cheasee-pi service. The codeflow service bind-mounts
		// ./codeflow/config.json, whose source path cannot resolve inside the
		// DinD daemon (auto-created as a directory -> ENOTDIR on mount).
		// codeflow is a sidecar not exercised by this smoke test.
		const result = exec(`docker compose -f "${composeFile(workdir)}" up -d cheasee-pi`, {
			timeout: 120_000,
			cwd: workdir,
		});
		assert.strictEqual(result.status, 0, `compose up exited ${result.status}: ${result.stderr}`);

		// Verify container is Up
		const psResult = exec(`docker ps --filter name=${CONTAINER_NAME} --format '{{.Status}}'`, {
			timeout: 10_000,
		});
		const status = psResult.stdout.trim().toLowerCase();
		assert.ok(status.startsWith("up"), `expected container status "Up", got: "${status}"`);
	});

	// ── Checkpoint 6: health check reaches healthy ─────────────────

	it("checkpoint 6 — health check reaches healthy within timeout", async () => {
		const status = await waitForHealthy(HEALTH_TIMEOUT_MS);
		assert.strictEqual(
			status,
			"healthy",
			`container health status expected "healthy", got: "${status}"`,
		);
	});

	// ── Checkpoint 7: pi --version inside container ────────────────

	it("checkpoint 7 — pi --version exits 0 inside container", () => {
		const result = exec(`docker exec ${CONTAINER_NAME} pi --version`, { timeout: 30_000 });
		assert.strictEqual(result.status, 0, `pi --version exited ${result.status}: ${result.stderr}`);
		const version = result.stdout.trim();
		assert.ok(version.length > 0, `expected pi --version output, got empty`);
	});

	// ── Checkpoint 8: cheasee-pi start with PTY launches pi ────────

	it("checkpoint 8 — cheasee-pi start with PTY launches pi", { timeout: 30_000 }, () => {
		// `script` allocates a PTY for the child. Without a PTY, docker exec -it
		// fails with "not a TTY", which would catch a different bug. We need -it
		// to mirror real user behavior.
		// `timeout 8` kills after 8s — if pi is running, it gets SIGKILLed cleanly.
		// Bug indicator: cheasee-pi start exits 0 → wrapper broke, pi never launched.
		const logPath = join(tmpdir(), `cheasee-pty-${Date.now()}.log`);
		const result = exec(`timeout 8 script -q -c '"${BINARY_PATH}" start' "${logPath}"`, {
			timeout: 30_000,
			cwd: workdir,
		});

		const logContent = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
		rmSync(logPath, { force: true });

		// Bug catch: clean exit means pi never started
		if (result.status === 0) {
			assert.fail(
				`cheasee-pi start exited 0 within 8s — pi did not launch. ` +
					`Last log:\n${logContent.slice(-2000)}`,
			);
		}

		// Strip ANSI escapes for cleaner matching
		const cleaned = logContent
			.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
			.replace(/\x1b\][^\x07]*\x07/g, "");

		// Verify pi actually rendered output. "Docker Engine" comes from
		// cheasee-pi startup; "SessionID" comes from pi's status bar.
		assert.ok(
			cleaned.includes("SessionID") || cleaned.includes("Docker Engine"),
			`expected pi output, got (cleaned, last 2000 chars):\n${cleaned.slice(-2000)}`,
		);
	});

	// ── Checkpoint 9: cheasee-pi down removes container ────────────

	it("checkpoint 9 — cheasee-pi down removes container", () => {
		const result = exec(`"${BINARY_PATH}" down --workdir "${workdir}"`, { timeout: 60_000 });
		assert.strictEqual(result.status, 0, `down exited ${result.status}: ${result.stderr}`);
		assert.ok(
			result.stderr.includes("Container stopped and removed"),
			`expected "Container stopped and removed" in stderr, got: ${result.stderr}`,
		);

		// Verify container is gone
		const psResult = exec(`docker ps --filter name=${CONTAINER_NAME} --format '{{.Names}}'`, {
			timeout: 10_000,
		});
		assert.strictEqual(
			psResult.stdout.trim(),
			"",
			`expected container gone, got: ${psResult.stdout}`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Error paths (independent, no compose dependency)
// ═══════════════════════════════════════════════════════════════════

describe("CLI install smoke — error paths", { timeout: 60_000 }, () => {
	let errWorkdir: string;

	before(() => {
		errWorkdir = mkdtempSync(join(tmpdir(), "cli-install-error-"));
	});

	after(() => {
		if (errWorkdir) {
			rmSync(errWorkdir, { recursive: true, force: true });
		}
	});

	it("adapter — init with --no-input but without --api-key exits non-zero", () => {
		const result = exec(
			`"${BINARY_PATH}" init --no-github --skip-fork --skip-submodules --no-input --no-docker-check --provider opencode-go --workdir "${errWorkdir}"`,
			{ timeout: 10_000 },
		);
		assert.notStrictEqual(result.status, 0, "expected non-zero exit for missing --api-key");
	});

	it("adapter — init with empty --api-key exits non-zero", () => {
		const result = exec(
			`"${BINARY_PATH}" init --no-github --skip-fork --skip-submodules --no-input --no-docker-check --api-key "" --provider opencode-go --workdir "${errWorkdir}"`,
			{ timeout: 10_000 },
		);
		assert.notStrictEqual(result.status, 0, "expected non-zero exit for empty --api-key");
	});

	it("adapter — non-existent binary exits non-zero", () => {
		const result = exec("/tmp/nonexistent-cheasee-pi --version", { timeout: 10_000 });
		assert.notStrictEqual(result.status, 0, "expected non-zero exit for non-existent binary");
	});
});

// ═══════════════════════════════════════════════════════════════════
// Boundary checks (generated file content validation)
// ═══════════════════════════════════════════════════════════════════

describe("CLI install smoke — boundaries", { timeout: 60_000 }, () => {
	let initWorkdir: string;

	before(() => {
		if (!binaryExists()) {
			throw new Error(
				`cheasee-pi binary not found at ${BINARY_PATH}. ` +
					"Set CHEASEE_PI_BIN env var or place the binary in the cwd.",
			);
		}
		initWorkdir = mkdtempSync(join(tmpdir(), "cli-install-boundary-"));
		// Run init once for boundary checks
		const result = exec(
			`"${BINARY_PATH}" init ` +
				"--no-github " +
				"--skip-fork " +
				"--skip-submodules " +
				"--no-input " +
				"--no-docker-check " +
				"--api-key ci-test-key " +
				"--provider opencode-go " +
				`--workdir "${initWorkdir}"`,
			{ timeout: 60_000 },
		);
		if (result.status !== 0) {
			throw new Error(`init failed for boundary tests: ${result.stderr}`);
		}
	});

	after(() => {
		if (initWorkdir) {
			rmSync(initWorkdir, { recursive: true, force: true });
		}
	});

	it("adapter — docker/.env contains expected vars", () => {
		const envPath = join(initWorkdir, "docker", ".env");
		const content = readFileSync(envPath, "utf-8");
		assert.ok(content.includes("HOST_UID="), ".env missing HOST_UID");
		assert.ok(content.includes("HOST_GID="), ".env missing HOST_GID");
		assert.ok(content.includes("HOST_GIT_NAME="), ".env missing HOST_GIT_NAME");
		assert.ok(content.includes("HOST_GIT_EMAIL="), ".env missing HOST_GIT_EMAIL");
	});

	it("adapter — .pi/settings.json is valid JSON with expected keys", () => {
		const settingsPath = join(initWorkdir, ".pi", "settings.json");
		const content = readFileSync(settingsPath, "utf-8");
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(content) as Record<string, unknown>;
		} catch {
			assert.fail(`.pi/settings.json is not valid JSON: ${content}`);
		}
		assert.ok("defaultProvider" in parsed, "settings.json missing defaultProvider");
		assert.ok("defaultModel" in parsed, "settings.json missing defaultModel");
		assert.ok("docker" in parsed, "settings.json missing docker");
		const docker = parsed.docker as Record<string, unknown>;
		assert.ok(docker?.memory, "settings.json missing docker.memory");
		assert.ok(docker?.cpus, "settings.json missing docker.cpus");
		assert.strictEqual(
			parsed.defaultProvider,
			"opencode-go",
			`expected defaultProvider to be "opencode-go", got: ${parsed.defaultProvider}`,
		);
	});

	it("adapter — init is idempotent (second run exits 0, no overwrite)", () => {
		const result = exec(
			`"${BINARY_PATH}" init ` +
				"--no-github " +
				"--skip-fork " +
				"--skip-submodules " +
				"--no-input " +
				"--no-docker-check " +
				"--api-key ci-test-key " +
				"--provider opencode-go " +
				`--workdir "${initWorkdir}"`,
			{ timeout: 60_000 },
		);
		assert.strictEqual(result.status, 0, `second init exited ${result.status}: ${result.stderr}`);

		// .pi/settings.json should not have been overwritten (idempotent)
		const settingsPath = join(initWorkdir, ".pi", "settings.json");
		const content = readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(content) as Record<string, unknown>;
		assert.strictEqual(
			parsed.defaultProvider,
			"opencode-go",
			`idempotent init should keep defaultProvider`,
		);
	});

	it("adapter — init without --provider flag uses default provider", () => {
		const noProvDir = mkdtempSync(join(tmpdir(), "cli-install-noprov-"));
		try {
			const result = exec(
				`"${BINARY_PATH}" init ` +
					"--no-github " +
					"--skip-fork " +
					"--skip-submodules " +
					"--no-input " +
					"--no-docker-check " +
					"--api-key ci-test-key " +
					`--workdir "${noProvDir}"`,
				{ timeout: 60_000 },
			);
			assert.strictEqual(
				result.status,
				0,
				`init without --provider exited ${result.status}: ${result.stderr}`,
			);
			const settingsPath = join(noProvDir, ".pi", "settings.json");
			const content = readFileSync(settingsPath, "utf-8");
			const parsed = JSON.parse(content) as Record<string, unknown>;
			assert.strictEqual(
				parsed.defaultProvider,
				"opencode-go",
				`expected defaultProvider to be "opencode-go", got: ${parsed.defaultProvider}`,
			);
		} finally {
			rmSync(noProvDir, { recursive: true, force: true });
		}
	});

	it("adapter — init in workdir whose parent is non-writable exits non-zero", () => {
		const parentDir = mkdtempSync(join(tmpdir(), "cli-install-nonwritable-"));
		const childWorkdir = join(parentDir, "sub");
		try {
			chmodSync(parentDir, 0o444); // remove write permission
			const result = exec(
				`"${BINARY_PATH}" init ` +
					"--no-github " +
					"--skip-fork " +
					"--skip-submodules " +
					"--no-input " +
					"--no-docker-check " +
					"--api-key ci-test-key " +
					"--provider opencode-go " +
					`--workdir "${childWorkdir}"`,
				{ timeout: 10_000 },
			);
			assert.notStrictEqual(result.status, 0, "expected non-zero exit for non-writable parent");
		} finally {
			chmodSync(parentDir, 0o755); // restore for cleanup
			rmSync(parentDir, { recursive: true, force: true });
		}
	});
});
