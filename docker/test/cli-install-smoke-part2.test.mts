import assert from "node:assert";

import { describe, it, before, after } from "node:test";

import { mkdtempSync, existsSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";

import { join, resolve } from "node:path";

import { tmpdir, homedir } from "node:os";

import { spawnSync } from "node:child_process";

import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";

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

const BINARY_PATH = process.env.CHEASEE_PI_BIN ?? resolve(process.cwd(), "cheasee-pi");

const SLUG = "cli-install-smoke";

const CONTAINER_NAME = `cheasee-pi-${SLUG}`;

const COMPOSE_PROJECT = CONTAINER_NAME;

const CODEFLOW_CONTAINER = `codeflow-${SLUG}`;

const HEALTH_TIMEOUT_MS = 120_000;

const POLL_INTERVAL_MS = 5_000;

const CLI_VERSION = "0.67.0";

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

function binaryExists(): boolean {
	return existsSync(BINARY_PATH);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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
