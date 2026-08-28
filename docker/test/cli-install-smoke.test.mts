/**
 * CLI installation smoke test (DinD, full user flow).
 *
 * Simulates a real user's machine:
 *   1. Download cheasee-pi binary (pre-built by workflow)
 *   2. git config --global (avoids prompts in scaffold)
 *   3. cheasee-pi init --no-github ... into an EMPTY folder (init is
 *      empty-folder-only: it sets the workspace up itself — the GitHub path
 *      bare-clones + worktrees; the legacy --no-github path scaffolds only)
 *   4. Verify scaffolded files (checkpoint 3)
 *   5. git init the workdir so build/start can mount it (the GitHub path's
 *      clone is replaced by the plain repo in this API-key-only smoke run)
 *   6. cheasee-pi build — extracts cache tree, compose build (checkpoint 4)
 *   7. docker compose up -d (checkpoint 5)
 *   8. Health check reaches healthy (checkpoint 6)
 *   9. pi --version inside container (checkpoint 7)
 *   10. cheasee-pi start with PTY (checkpoint 8)
 *   11. cheasee-pi down (checkpoint 9)
 *
 * compose/Dockerfile no longer live in the user repo — init is
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
import {
	mkdtempSync,
	existsSync,
	readFileSync,
	rmSync,
	chmodSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
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

// The smoke workspace's sibling bare repo is seeded with this remote
// (before() below) so the CLI's per-repo slug derivation is deterministic:
// repoSlug reads remote.origin.url from <parent>/.bare and maps it to
// <owner>-<repo> — the remote is seeded owner-less (https://github.com/<SLUG>)
// so the derived slug equals SLUG exactly and the container/project names
// below match what `cheasee-pi start`/`down` resolve. Falling back to the
// workspace basename would not (mkdtemp names are random).
// Container, compose project and codeflow sidecar names all carry the slug,
// so `cheasee-pi down` (checkpoint 9) resolves the exact project
// `cheasee-pi start` used.
const SLUG = "cli-install-smoke";
const CONTAINER_NAME = `cheasee-pi-${SLUG}`;
const COMPOSE_PROJECT = CONTAINER_NAME;
const CODEFLOW_CONTAINER = `codeflow-${SLUG}`;
const HEALTH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;

/**
 * CLI version key — must match cliVersionKey in cmd/cheasee-pi/cache.go.
 * The cache dir is version-keyed so an upgraded binary never mixes stale
 * compose/Dockerfile content with new embedded assets.
 */
const CLI_VERSION = "0.55.2";

/**
 * Compute the CLI cache dir (compose/Dockerfile live there,
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

		// Create a fresh EMPTY temp directory for the test — init is
		// empty-folder-only (cheasee-pi sets the workspace up itself).
		workdir = mkdtempSync(join(tmpdir(), "cli-install-"));
		// The sibling bare mount source: the compose file bind-mounts
		// ${WORKSPACE_BARE_PATH}:/workspaces/.bare, and compose validates
		// every volume spec even for raw `up`. Seed it as a bare repo with a
		// remote so the CLI's per-repo slug derivation is deterministic
		// (container/project = cheasee-pi-cli-install-smoke, same name both
		// checkpoint 5's raw compose up and checkpoint 9's `down` resolve);
		// a bare repo without worktrees is still skipped by worktree-fix.
		const barePath = join(workdir, "..", ".bare");
		mkdirSync(barePath, { recursive: true });
		const bareInit = exec(`git init --bare -q "${barePath}"`, { timeout: 10_000 });
		assert.strictEqual(
			bareInit.status,
			0,
			`git init --bare exited ${bareInit.status}: ${bareInit.stderr}`,
		);
		const bareRemote = exec(
			`git --git-dir "${barePath}" remote add origin https://github.com/${SLUG}.git`,
			{ timeout: 10_000 },
		);
		assert.strictEqual(
			bareRemote.status,
			0,
			`bare remote add exited ${bareRemote.status}: ${bareRemote.stderr}`,
		);
	});

	after(() => {
		// Clean up: compose down if container is running
		if (workdir) {
			exec(`docker compose -f "${composeFile()}" down -v 2>/dev/null || true`, {
				timeout: 30_000,
			});
			// The per-repo container may not belong to the pinned-name project
			// above — remove it by name (best-effort safety net on failure).
			exec(`docker rm -fv ${CONTAINER_NAME} 2>/dev/null || true`, {
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

	// ── Checkpoint 3: dedicated settings file, no docker files ──

	it("checkpoint 3 — cheasee-settings.json is scaffolded at the folder root", () => {
		// The dedicated, gitignored settings file marks the workspace
		// initialized — independent from pi's own .pi/settings.json (which pi
		// self-scaffolds on first run, so init must not create it).
		const settingsPath = join(workdir, "cheasee-settings.json");
		assert.ok(existsSync(settingsPath), `expected file to exist: cheasee-settings.json`);
		const content = readFileSync(settingsPath, "utf-8");
		assert.ok(content.length > 0, `expected non-empty file: cheasee-settings.json`);
		assert.ok(
			content.includes('"docker"'),
			`expected docker section in cheasee-settings.json, got: ${content}`,
		);
		// pi's own settings file is NOT injected by init.
		assert.ok(
			!existsSync(join(workdir, ".pi", "settings.json")),
			"init must not scaffold .pi/settings.json (pi self-scaffolds it)",
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

	// ── Checkpoint 3b: plain git repo for build/start (smoke substitute) ──

	it("checkpoint 3b — workdir is a git repo for the build/start journey", () => {
		// The GitHub init path produces a bare clone + main worktree here; the
		// legacy --no-github path (API-key only) leaves the folder repo-less.
		// The smoke run mounts the folder as the pi workspace, so make it a
		// plain repo — build/start require a git toplevel.
		const init = exec(`git init -q "${workdir}"`, { timeout: 10_000 });
		assert.strictEqual(init.status, 0, `git init exited ${init.status}: ${init.stderr}`);
	});

	// ── Checkpoint 4: cheasee-pi build (extract cache tree + compose build)

	it("checkpoint 4 — cheasee-pi build exits 0", () => {
		// build is the binary's extract-then-build path: it stages the embedded
		// compose/Dockerfile into the version-keyed cache dir and
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
			env: {
				WORKSPACE_HOST_PATH: workdir,
				// Sibling bare repo — same resolution the CLI applies
				// (applyComposeEnv: <parent>/.bare → /workspaces/.bare).
				WORKSPACE_BARE_PATH: join(workdir, "..", ".bare"),
				// Mirror the CLI's per-repo compose env (applyComposeEnv): the
				// project and container names carry the repo slug, so the
				// container created here is the one `cheasee-pi down`
				// (checkpoint 9) resolves and removes.
				COMPOSE_PROJECT_NAME: COMPOSE_PROJECT,
				CHEASEEPI_CONTAINER: CONTAINER_NAME,
				CODEFLOW_CONTAINER,
			},
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

		// Extensions must load cleanly — a boot that only *survives* (pi treats
		// extension load failure as non-fatal and keeps running) but shows
		// "Failed to load extension" is a broken image. The stale-dir npm
		// guard bug (#1561) produced exactly this: pi boots, extensions fail.
		assert.ok(
			!cleaned.includes("Failed to load extension"),
			`extension load failed at pi boot (cleaned, last 2000 chars):\n${cleaned.slice(-2000)}`,
		);
	});

	// ── Checkpoint 9: cheasee-pi down removes container ────────────

	it("checkpoint 9 — cheasee-pi down removes container", () => {
		// down resolves the per-repo compose project (cheasee-pi-<slug>) from
		// the workspace root like start — run inside the workspace so
		// findWorkspaceRoot finds cheasee-settings.json, and the slug via the
		// seeded sibling bare repo's remote, matching checkpoint 5's project.
		const result = exec(`"${BINARY_PATH}" down`, { timeout: 60_000, cwd: workdir });
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

	it("adapter — start on a non-empty folder without settings is refused", () => {
		// An empty folder auto-inits; a non-empty folder without
		// cheasee-settings.json is refused (cheasee-pi never auto-initializes
		// existing folders). errWorkdir is empty for the init error tests, so
		// use a separate non-empty fixture here.
		const refusedDir = mkdtempSync(join(tmpdir(), "cli-install-refused-"));
		try {
			writeFileSync(join(refusedDir, "somefile.txt"), "x");
			const result = exec(`"${BINARY_PATH}" start --no-docker-check --dry-run`, {
				timeout: 10_000,
				cwd: refusedDir,
			});
			assert.notStrictEqual(result.status, 0, "expected non-zero exit for non-initialized folder");
			assert.ok(
				result.stderr.includes("not initialized"),
				`expected refusal mentioning "not initialized", got: ${result.stderr}`,
			);
		} finally {
			rmSync(refusedDir, { recursive: true, force: true });
		}
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
		// embedded docker tree on the way (regenerable).
		const result = exec(`"${BINARY_PATH}" down`, { timeout: 60_000, cwd: initWorkdir });
		assert.strictEqual(result.status, 0, `down exited ${result.status}: ${result.stderr}`);
		for (const f of ["docker-compose.yml", "Dockerfile", "entrypoint.sh", "lib/worktree-fix.sh"]) {
			const fullPath = join(composeDir(), f);
			assert.ok(existsSync(fullPath), `expected cache dir file to exist: ${f} (${fullPath})`);
			assert.ok(readFileSync(fullPath, "utf-8").length > 0, `expected non-empty file: ${f}`);
		}
	});

	it("adapter — start --dry-run on an empty folder prints the auto-init plan and touches nothing", () => {
		// dry-run is side-effect-free: on an empty folder it prints what the
		// start gate would do (auto-init) and exits — no scaffold, no compose,
		// no clone, no .bare, no settings file. Nested under a fresh parent so
		// the sibling .bare assertion can't collide with other suites' mounts.
		const parent = mkdtempSync(join(tmpdir(), "cli-install-dryrun-parent-"));
		const dryDir = join(parent, "ws");
		mkdirSync(dryDir);
		try {
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
				result.stderr.includes("would run `cheasee-pi init`"),
				`expected auto-init plan in stderr, got: ${result.stderr}`,
			);
			assert.ok(
				!existsSync(join(dryDir, "cheasee-settings.json")),
				"dry-run must not scaffold cheasee-settings.json",
			);
			assert.ok(
				!existsSync(join(dryDir, "..", ".bare")),
				"dry-run must not create the sibling .bare",
			);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("adapter — start --dry-run on an initialized workspace prints the docker command", () => {
		// initWorkdir has cheasee-settings.json (initialized marker), so the
		// gate passes and dry-run prints the would-be docker command without
		// touching anything (no scaffold, no compose, no cache extraction).
		const result = exec(`"${BINARY_PATH}" start --no-docker-check --dry-run`, {
			timeout: 30_000,
			cwd: initWorkdir,
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
			!existsSync(join(initWorkdir, ".pi", "settings.json")),
			"dry-run must not scaffold .pi/settings.json",
		);
	});

	it("adapter — cheasee-settings.json is valid JSON with expected keys", () => {
		const settingsPath = join(initWorkdir, "cheasee-settings.json");
		const content = readFileSync(settingsPath, "utf-8");
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(content) as Record<string, unknown>;
		} catch {
			assert.fail(`cheasee-settings.json is not valid JSON: ${content}`);
		}
		assert.ok("defaultProvider" in parsed, "cheasee-settings.json missing defaultProvider");
		assert.ok("defaultModel" in parsed, "cheasee-settings.json missing defaultModel");
		assert.ok("docker" in parsed, "cheasee-settings.json missing docker");
		const docker = parsed.docker as Record<string, unknown>;
		assert.ok(docker?.memory, "cheasee-settings.json missing docker.memory");
		assert.ok(docker?.cpus, "cheasee-settings.json missing docker.cpus");
		assert.ok("gitIdentity" in parsed, "cheasee-settings.json missing gitIdentity");
		assert.ok("oauth" in parsed, "cheasee-settings.json missing oauth");
		assert.strictEqual(
			parsed.defaultProvider,
			"opencode-go",
			`expected defaultProvider to be "opencode-go", got: ${parsed.defaultProvider}`,
		);
		// pi's own settings file is NOT scaffolded by init (pi self-scaffolds
		// on first run); the dedicated file is the only settings output.
		assert.ok(
			!existsSync(join(initWorkdir, ".pi", "settings.json")),
			"init must not scaffold .pi/settings.json",
		);
	});

	it("adapter — init on an already-initialized folder refuses (presence = marker)", () => {
		// cheasee-settings.json presence marks the workspace initialized; a
		// second init must refuse outright instead of re-applying.
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
		assert.notStrictEqual(
			result.status,
			0,
			`second init should be refused, exited ${result.status}: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("already initialized"),
			`expected "already initialized" refusal, got: ${result.stderr}`,
		);

		// The existing file must be untouched by the refused re-init.
		const settingsPath = join(initWorkdir, "cheasee-settings.json");
		const content = readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(content) as Record<string, unknown>;
		assert.strictEqual(
			parsed.defaultProvider,
			"opencode-go",
			`refused re-init should keep defaultProvider`,
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
			const settingsPath = join(noProvDir, "cheasee-settings.json");
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
