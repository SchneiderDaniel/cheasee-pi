/**
 * CLI installation smoke test (DinD, full user flow).
 *
 * Simulates a real user's machine:
 *   1. Download cheasee-pi binary (pre-built by workflow)
 *   2. git config --global (avoids prompts in scaffold) + git init the workdir
 *   3. cheasee-pi init --no-github ... (all flags to skip interactivity)
 *   4. Verify scaffolded files (checkpoint 3)
 *   5. cheasee-pi build — extracts cache tree, compose build (checkpoint 4)
 *   6. docker compose up -d (checkpoint 5)
 *   7. Health check reaches healthy (checkpoint 6)
 *   8. pi --version inside container (checkpoint 7)
 *   9. cheasee-pi start with PTY (checkpoint 8)
 *   10. cheasee-pi down (checkpoint 9)
 *
 * compose/Dockerfile/pi-resources no longer live in the user repo — init is
 * scaffold-only (no docker/ dir, no clone, no fork) and start extracts the
 * embedded compose tree into the version-keyed CLI cache dir
 * (<XDG_CACHE_HOME>/cheasee-pi/<cliVersion>/). This test computes that path
 * the same way the CLI does (cache.go CacheDir + cliVersionKey).
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
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";

// Redirect auth.json to a test-only location so `init` subprocesses
// don't clobber the real ~/.config/cheasee-pi/auth.json on the host.
// The cache dir follows XDG_CACHE_HOME too (os.UserCacheDir honors it).
const testXdgHome = mkdtempSync(join(tmpdir(), "cheasee-pi-test-xdg-"));
process.env.XDG_CONFIG_HOME = testXdgHome;
process.env.XDG_CACHE_HOME = testXdgHome;
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
 * CLI version key — must match cliVersionKey in cmd/cheasee-pi/cache.go.
 * The cache dir is version-keyed so an upgraded binary never mixes stale
 * compose/Dockerfile/pi-resources content with new embedded assets.
 */
const CLI_VERSION = "0.50";

/**
 * Compute the CLI cache dir (compose/Dockerfile/pi-resources live there,
 * extracted by `cheasee-pi start`, never in the user repo).
 */
function composeDir(): string {
	return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "cheasee-pi", CLI_VERSION);
}

function composeFile(): string {
	return join(composeDir(), "docker-compose.yml");
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
// Smoke test — full user flow (checkpoints 1-9)
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
		// `cheasee-pi start` only runs inside a git repository — the user's
		// own repo is the pi workspace (mounted at /workspaces/main).
		const init = exec(`git init -q "${workdir}"`, { timeout: 10_000 });
		assert.strictEqual(init.status, 0, `git init exited ${init.status}: ${init.stderr}`);
	});

	after(() => {
		// Clean up: compose down if container is running
		if (workdir) {
			exec(`docker compose -f "${composeFile()}" down -v 2>/dev/null || true`, {
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
				"" +
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

	// ── Checkpoint 3: scaffold-only — settings.json, no docker files ──

	it("checkpoint 3 — only .pi/settings.json is scaffolded into the repo", () => {
		// The only artifact written into the user repo is .pi/settings.json.
		const settingsPath = join(workdir, ".pi", "settings.json");
		assert.ok(existsSync(settingsPath), `expected file to exist: .pi/settings.json`);
		const content = readFileSync(settingsPath, "utf-8");
		assert.ok(content.length > 0, `expected non-empty file: .pi/settings.json`);
		// Absolute /opt/cheasee-pi resource paths — the image bakes the
		// cheasee-pi resource tree there (never ../private-pi/... siblings).
		assert.ok(
			content.includes("/opt/cheasee-pi/.pi/skills"),
			`expected /opt/cheasee-pi/.pi/skills in settings, got: ${content}`,
		);
		// No docker/ tree, no compose, no scripts in the user repo.
		assert.ok(
			!existsSync(join(workdir, "docker")),
			"init must not create a docker/ dir in the user repo",
		);
		assert.ok(
			!existsSync(join(workdir, "docker-compose.yml")),
			"init must not create docker-compose.yml in the user repo",
		);
	});

	// ── Checkpoint 4: cheasee-pi build (extract cache tree + compose build)

	it("checkpoint 4 — cheasee-pi build exits 0", () => {
		// build is the binary's extract-then-build path: it stages the embedded
		// compose/Dockerfile/pi-resources into the version-keyed cache dir and
		// runs `docker compose build` from there. The raw compose command cannot
		// run first — the cache dir starts empty until the binary extracts.
		const result = exec(`"${BINARY_PATH}" build --no-docker-check`, {
			timeout: 600_000,
			cwd: workdir, // 10 min — cold build is slow
		});
		assert.strictEqual(result.status, 0, `build exited ${result.status}: ${result.stderr}`);
	});

	// ── Checkpoint 5: docker compose up -d ─────────────────────────

	it("checkpoint 5 — docker compose up -d exits 0, container running", () => {
		// Start only the cheasee-pi service. The codeflow service bind-mounts
		// ./codeflow/config.json, whose source path cannot resolve inside the
		// DinD daemon (auto-created as a directory -> ENOTDIR on mount).
		// codeflow is a sidecar not exercised by this smoke test.
		const result = exec(`docker compose -f "${composeFile()}" up -d cheasee-pi`, {
			timeout: 120_000,
			cwd: workdir,
			env: { WORKSPACE_HOST_PATH: workdir },
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
		// down resolves the same compose project from the cache dir — no
		// --workdir needed (top-level `name: cheasee-pi` pins the project).
		const result = exec(`"${BINARY_PATH}" down`, { timeout: 60_000 });
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
			`"${BINARY_PATH}" init --no-github --no-input --no-docker-check --provider opencode-go --workdir "${errWorkdir}"`,
			{ timeout: 10_000 },
		);
		assert.notStrictEqual(result.status, 0, "expected non-zero exit for missing --api-key");
	});

	it("adapter — init with empty --api-key exits non-zero", () => {
		const result = exec(
			`"${BINARY_PATH}" init --no-github --no-input --no-docker-check --api-key "" --provider opencode-go --workdir "${errWorkdir}"`,
			{ timeout: 10_000 },
		);
		assert.notStrictEqual(result.status, 0, "expected non-zero exit for empty --api-key");
	});

	it("adapter — removed fork/clone flags are rejected by cobra", () => {
		const result = exec(
			`"${BINARY_PATH}" init --no-github --skip-fork --no-input --no-docker-check --api-key ci-test-key --provider opencode-go --workdir "${errWorkdir}"`,
			{ timeout: 10_000 },
		);
		assert.notStrictEqual(result.status, 0, "expected non-zero exit for removed --skip-fork flag");
	});

	it("adapter — start outside a git repository is refused", () => {
		const result = exec(`"${BINARY_PATH}" start --no-docker-check --dry-run`, {
			timeout: 10_000,
			cwd: errWorkdir,
		});
		assert.notStrictEqual(result.status, 0, "expected non-zero exit for non-git cwd");
		assert.ok(
			result.stderr.includes("git"),
			`expected error mentioning git, got: ${result.stderr}`,
		);
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
				"" +
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

	it("adapter — down extracts compose/Dockerfile into the version-keyed cache dir", () => {
		// down resolves the compose project from the cache dir, extracting the
		// embedded docker tree + pi-resources staging on the way (regenerable).
		const result = exec(`"${BINARY_PATH}" down`, { timeout: 60_000, cwd: initWorkdir });
		assert.strictEqual(result.status, 0, `down exited ${result.status}: ${result.stderr}`);
		for (const f of [
			"docker-compose.yml",
			"Dockerfile",
			"entrypoint.sh",
			"lib/worktree-fix.sh",
			".dockerignore",
		]) {
			const fullPath = join(composeDir(), f);
			assert.ok(existsSync(fullPath), `expected cache dir file to exist: ${f} (${fullPath})`);
			assert.ok(readFileSync(fullPath, "utf-8").length > 0, `expected non-empty file: ${f}`);
		}
		// The staged pi-resources tree feeds COPY pi-resources/ /opt/cheasee-pi/
		const staged = join(composeDir(), "pi-resources", ".pi", "skills");
		assert.ok(existsSync(staged), `expected staged pi-resources/.pi/skills at ${staged}`);
	});

	it("adapter — start --dry-run prints without scaffolding or touching docker", () => {
		// dry-run is side-effect-free: git check + env print only. In a git
		// repo it must not scaffold (no .pi/settings.json yet) and must not
		// invoke compose — it just prints the would-be docker command.
		const dryDir = mkdtempSync(join(tmpdir(), "cli-install-dryrun-"));
		try {
			const init = exec(`git init -q "${dryDir}"`, { timeout: 10_000 });
			assert.strictEqual(init.status, 0, `git init exited ${init.status}: ${init.stderr}`);
			const result = exec(`"${BINARY_PATH}" start --no-docker-check --dry-run`, {
				timeout: 30_000,
				cwd: dryDir,
			});
			assert.strictEqual(
				result.status,
				0,
				`start --dry-run exited ${result.status}: ${result.stderr}`,
			);
			assert.ok(
				result.stderr.includes("Docker command"),
				`expected dry-run docker command in stderr, got: ${result.stderr}`,
			);
			assert.ok(
				!existsSync(join(dryDir, ".pi", "settings.json")),
				"dry-run must not scaffold .pi/settings.json",
			);
		} finally {
			rmSync(dryDir, { recursive: true, force: true });
		}
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
		// Absolute /opt/cheasee-pi resource paths (baked into the image)
		assert.ok(
			content.includes("/opt/cheasee-pi/.pi/skills"),
			`expected /opt/cheasee-pi skills path, got: ${content}`,
		);
		assert.ok(
			!content.includes("../private-pi"),
			`settings must not reference ../private-pi sibling paths: ${content}`,
		);
	});

	it("adapter — init is idempotent (second run exits 0, no overwrite)", () => {
		const result = exec(
			`"${BINARY_PATH}" init ` +
				"--no-github " +
				"" +
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
					"" +
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
					"" +
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
