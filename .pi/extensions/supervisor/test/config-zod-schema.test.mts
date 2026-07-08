// ─── Tests: Zod schema validation for SupervisorConfig ───────────
// Phase 1: Pure schema parse (entity tests)
// Phase 2: loadConfig integration (adapter tests)
// Phase 3: Type contract (compile-time checks)

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { z } from "zod";
import { SupervisorConfigSchema } from "../config/config.ts";
import { loadConfig } from "../config/config.ts";
import type { SupervisorConfig } from "../config/types.ts";

// ═══════════════════════════════════════════════════════════════════
// Phase 1: Schema validation — pure parse
// ═══════════════════════════════════════════════════════════════════

const validMinimal = {
	repo: "owner/repo",
	projectNumber: 1,
	statusMapping: { todo: "developer" },
	codeowners: ["user"],
};

const validFull = {
	repo: "owner/repo",
	projectNumber: 42,
	statusField: "Pipeline Status",
	statusMapping: { todo: "developer", done: "auditor" },
	maxRejections: 5,
	codeowners: ["user1", "user2"],
	submodules: [{ path: "lib", repo: "owner/lib" }],
	defaultBranch: "develop",
	remote: "upstream",
	worktreeBase: "/tmp/worktrees/",
	branchPrefix: "feature-",
	agentTimeoutsMin: { developer: 10, auditor: 20 },
	ciGatingTimeoutSec: 600,
	bellOnComplete: true,
	agentTokenBudget: 100000,
	maxToolCalls: 50,
	enableExperimentalFeatures: true,
	auditScoreThreshold: 0.85,
	vulnGateBlocking: true,
	vulnGateTimeoutSec: 120,
};

describe("SupervisorConfigSchema — parse", () => {
	it("parses valid minimal config and applies defaults", () => {
		const result = SupervisorConfigSchema.parse(validMinimal);
		assert.equal(result.repo, "owner/repo");
		assert.equal(result.projectNumber, 1);
		assert.equal(result.statusField, "Status");
		assert.deepEqual(result.statusMapping, { todo: "developer" });
		assert.equal(result.maxRejections, 3);
		assert.deepEqual(result.codeowners, ["user"]);
		assert.equal(result.defaultBranch, "main");
		assert.equal(result.remote, "origin");
		assert.equal(result.worktreeBase, "../");
		assert.equal(result.branchPrefix, "worktree-git-issue-");
		assert.equal(result.ciGatingTimeoutSec, 300);
		assert.equal(result.bellOnComplete, false);
		assert.equal(result.enableExperimentalFeatures, false);
		assert.equal(result.auditScoreThreshold, 0.75);
		assert.equal(result.vulnGateBlocking, false);
		assert.equal(result.vulnGateTimeoutSec, 60);
		// submodules defaults to undefined (optional, no .default())
		assert.equal(result.submodules, undefined);
		// agentTimeoutsMin defaults to undefined (optional, no .default())
		assert.equal(result.agentTimeoutsMin, undefined);
	});

	it("parses valid full config and preserves all explicit values", () => {
		const result = SupervisorConfigSchema.parse(validFull);
		assert.equal(result.repo, "owner/repo");
		assert.equal(result.projectNumber, 42);
		assert.equal(result.statusField, "Pipeline Status");
		assert.deepEqual(result.statusMapping, { todo: "developer", done: "auditor" });
		assert.equal(result.maxRejections, 5);
		assert.deepEqual(result.codeowners, ["user1", "user2"]);
		assert.deepEqual(result.submodules, [{ path: "lib", repo: "owner/lib" }]);
		assert.equal(result.defaultBranch, "develop");
		assert.equal(result.remote, "upstream");
		assert.equal(result.worktreeBase, "/tmp/worktrees/");
		assert.equal(result.branchPrefix, "feature-");
		assert.deepEqual(result.agentTimeoutsMin, { developer: 10, auditor: 20 });
		assert.equal(result.ciGatingTimeoutSec, 600);
		assert.equal(result.bellOnComplete, true);
		assert.equal(result.agentTokenBudget, 100000);
		assert.equal(result.maxToolCalls, 50);
		assert.equal(result.enableExperimentalFeatures, true);
		assert.equal(result.auditScoreThreshold, 0.85);
		assert.equal(result.vulnGateBlocking, true);
		assert.equal(result.vulnGateTimeoutSec, 120);
	});

	it("strips unknown fields by default", () => {
		const result = SupervisorConfigSchema.parse({
			...validMinimal,
			unknownField: "should be stripped",
			anotherUnknown: 42,
		});
		assert.equal(result.repo, "owner/repo");
		assert.equal((result as Record<string, unknown>).unknownField, undefined);
	});

	// ── repo ─────────────────────────────────────────────────────

	it("throws ZodError when repo is missing", () => {
		const { repo, ...noRepo } = validMinimal;
		assert.throws(() => SupervisorConfigSchema.parse(noRepo), z.ZodError);
	});

	it("throws ZodError when repo is empty string", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, repo: "" }),
			z.ZodError,
		);
	});

	// ── projectNumber ────────────────────────────────────────────

	it("throws ZodError when projectNumber is missing", () => {
		const { projectNumber, ...noPN } = validMinimal;
		assert.throws(() => SupervisorConfigSchema.parse(noPN), z.ZodError);
	});

	it("throws ZodError when projectNumber is negative", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, projectNumber: -1 }),
			z.ZodError,
		);
	});

	it("throws ZodError when projectNumber is float", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, projectNumber: 1.5 }),
			z.ZodError,
		);
	});

	it("throws ZodError when projectNumber is string", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, projectNumber: "1" }),
			z.ZodError,
		);
	});

	// ── statusMapping ────────────────────────────────────────────

	it("throws ZodError when statusMapping is missing", () => {
		const { statusMapping, ...noSM } = validMinimal;
		assert.throws(() => SupervisorConfigSchema.parse(noSM), z.ZodError);
	});

	it("throws ZodError when statusMapping is empty object", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, statusMapping: {} }),
			z.ZodError,
		);
	});

	it("accepts statusMapping with empty string values", () => {
		const result = SupervisorConfigSchema.parse({
			...validMinimal,
			statusMapping: { todo: "" },
		});
		assert.equal(result.statusMapping.todo, "");
	});

	// ── codeowners ───────────────────────────────────────────────

	it("throws ZodError when codeowners is missing", () => {
		const { codeowners, ...noCO } = validMinimal;
		assert.throws(() => SupervisorConfigSchema.parse(noCO), z.ZodError);
	});

	it("throws ZodError when codeowners is empty array", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, codeowners: [] }),
			z.ZodError,
		);
	});

	it("throws ZodError when codeowners is not an array", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, codeowners: "not-an-array" }),
			z.ZodError,
		);
	});

	// ── agentTokenBudget ─────────────────────────────────────────

	it("throws ZodError when agentTokenBudget is negative", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, agentTokenBudget: -1 }),
			z.ZodError,
		);
	});

	it("throws ZodError when agentTokenBudget is float", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, agentTokenBudget: 1.5 }),
			z.ZodError,
		);
	});

	it("throws ZodError when agentTokenBudget is string", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, agentTokenBudget: "50000" }),
			z.ZodError,
		);
	});

	it("allows agentTokenBudget to be undefined (optional)", () => {
		const result = SupervisorConfigSchema.parse(validMinimal);
		assert.equal(result.agentTokenBudget, undefined);
	});

	// ── maxToolCalls ─────────────────────────────────────────────

	it("throws ZodError when maxToolCalls is negative", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, maxToolCalls: -1 }),
			z.ZodError,
		);
	});

	// ── enableExperimentalFeatures ───────────────────────────────

	it("throws ZodError when enableExperimentalFeatures is string", () => {
		assert.throws(
			() =>
				SupervisorConfigSchema.parse({ ...validMinimal, enableExperimentalFeatures: "yes" }),
			z.ZodError,
		);
	});

	it("defaults enableExperimentalFeatures to false when undefined", () => {
		const result = SupervisorConfigSchema.parse(validMinimal);
		assert.equal(result.enableExperimentalFeatures, false);
	});

	// ── auditScoreThreshold ──────────────────────────────────────

	it("throws ZodError when auditScoreThreshold exceeds 1.0", () => {
		assert.throws(
			() =>
				SupervisorConfigSchema.parse({ ...validMinimal, auditScoreThreshold: 1.5 }),
			z.ZodError,
		);
	});

	it("throws ZodError when auditScoreThreshold is below 0", () => {
		assert.throws(
			() =>
				SupervisorConfigSchema.parse({ ...validMinimal, auditScoreThreshold: -0.1 }),
			z.ZodError,
		);
	});

	it("throws ZodError when auditScoreThreshold is NaN", () => {
		assert.throws(
			() =>
				SupervisorConfigSchema.parse({ ...validMinimal, auditScoreThreshold: NaN }),
			z.ZodError,
		);
	});

	it("defaults auditScoreThreshold to 0.75 when undefined", () => {
		const result = SupervisorConfigSchema.parse(validMinimal);
		assert.equal(result.auditScoreThreshold, 0.75);
	});

	// ── vulnGateBlocking / vulnGateTimeoutSec ────────────────────

	it("throws ZodError when vulnGateBlocking is string", () => {
		assert.throws(
			() => SupervisorConfigSchema.parse({ ...validMinimal, vulnGateBlocking: "true" }),
			z.ZodError,
		);
	});

	it("throws ZodError when vulnGateTimeoutSec is negative", () => {
		assert.throws(
			() =>
				SupervisorConfigSchema.parse({ ...validMinimal, vulnGateTimeoutSec: -5 }),
			z.ZodError,
		);
	});

	// ── submodules ───────────────────────────────────────────────

	it("accepts valid submodules array", () => {
		const result = SupervisorConfigSchema.parse({
			...validMinimal,
			submodules: [{ path: "lib", repo: "owner/repo" }],
		});
		assert.deepEqual(result.submodules, [{ path: "lib", repo: "owner/repo" }]);
	});

	it("throws ZodError when submodule path is wrong type", () => {
		assert.throws(
			() =>
				SupervisorConfigSchema.parse({
					...validMinimal,
					submodules: [{ path: 123 }],
				}),
			z.ZodError,
		);
	});

	// ── agentTimeoutsMin ─────────────────────────────────────────

	it("accepts agentTimeoutsMin as record of string to number", () => {
		const result = SupervisorConfigSchema.parse({
			...validMinimal,
			agentTimeoutsMin: { developer: 10 },
		});
		assert.deepEqual(result.agentTimeoutsMin, { developer: 10 });
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2: loadConfig integration — temp filesystem
// ═══════════════════════════════════════════════════════════════════

describe("loadConfig — zod integration", () => {
	let testDir: string;
	let origCwd: string;

	beforeEach(() => {
		origCwd = process.cwd();
		testDir = join(tmpdir(), "pi-zod-loadconfig-" + Date.now());
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(join(testDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		process.chdir(origCwd);
		rmSync(testDir, { recursive: true, force: true });
	});

	function writeSettings(data: Record<string, unknown>) {
		writeFileSync(join(testDir, ".pi", "settings.json"), JSON.stringify(data), "utf-8");
	}

	it("returns properly typed config with defaults for valid settings", () => {
		writeSettings({
			supervisor: {
				repo: "owner/repo",
				projectNumber: 1,
				statusMapping: { todo: "developer" },
				codeowners: ["user"],
			},
		});
		process.chdir(testDir);
		const config = loadConfig();
		assert.equal(config.repo, "owner/repo");
		assert.equal(config.projectNumber, 1);
		assert.equal(config.maxRejections, 3);
		assert.equal(config.ciGatingTimeoutSec, 300);
		assert.equal(config.bellOnComplete, false);
		assert.equal(config.enableExperimentalFeatures, false);
		assert.equal(config.auditScoreThreshold, 0.75);
		assert.equal(config.vulnGateBlocking, false);
		assert.equal(config.vulnGateTimeoutSec, 60);
	});

	it("throws 'No .pi/settings.json found' when settings missing", () => {
		// Don't write settings file
		process.chdir(testDir);
		assert.throws(() => loadConfig(), /No .pi\/settings.json found/);
	});

	it("throws 'No supervisor key' when supervisor key missing", () => {
		writeSettings({});
		process.chdir(testDir);
		assert.throws(() => loadConfig(), /No 'supervisor' key/);
	});

	it("throws ZodError when statusMapping is empty object", () => {
		writeSettings({
			supervisor: {
				repo: "owner/repo",
				projectNumber: 1,
				statusMapping: {},
				codeowners: ["user"],
			},
		});
		process.chdir(testDir);
		assert.throws(() => loadConfig(), z.ZodError);
	});

	it("throws ZodError when repo is empty string", () => {
		writeSettings({
			supervisor: {
				repo: "",
				projectNumber: 1,
				statusMapping: { todo: "developer" },
				codeowners: ["user"],
			},
		});
		process.chdir(testDir);
		assert.throws(() => loadConfig(), z.ZodError);
	});

	it("includes vulnGateBlocking and vulnGateTimeoutSec with defaults", () => {
		writeSettings({
			supervisor: {
				repo: "owner/repo",
				projectNumber: 1,
				statusMapping: { todo: "developer" },
				codeowners: ["user"],
			},
		});
		process.chdir(testDir);
		const config = loadConfig();
		assert.equal(config.vulnGateBlocking, false);
		assert.equal(config.vulnGateTimeoutSec, 60);
	});

	it("includes all fields when full valid config is provided", () => {
		writeSettings({
			supervisor: validFull,
		});
		process.chdir(testDir);
		const config = loadConfig();
		assert.equal(config.repo, "owner/repo");
		assert.equal(config.projectNumber, 42);
		assert.equal(config.statusField, "Pipeline Status");
		assert.equal(config.maxRejections, 5);
		assert.equal(config.ciGatingTimeoutSec, 600);
		assert.equal(config.bellOnComplete, true);
		assert.equal(config.agentTokenBudget, 100000);
		assert.equal(config.maxToolCalls, 50);
		assert.equal(config.enableExperimentalFeatures, true);
		assert.equal(config.auditScoreThreshold, 0.85);
		assert.equal(config.vulnGateBlocking, true);
		assert.equal(config.vulnGateTimeoutSec, 120);
		assert.deepEqual(config.submodules, [{ path: "lib", repo: "owner/lib" }]);
	});
});

// ═══════════════════════════════════════════════════════════════════
// Phase 3: Type contract — compile-time checks
// ═══════════════════════════════════════════════════════════════════

describe("SupervisorConfig type compatibility", () => {
	it("Schema-inferred type is assignable to SupervisorConfig import", () => {
		// This is a compile-time check: if SupervisorConfigSchema is exported
		// and its inferred type matches the re-exported type, the assignment works.
		const schema: z.ZodType<SupervisorConfig> = SupervisorConfigSchema;
		assert.ok(schema instanceof z.ZodType);
	});

	it("Fields with .default() are present in parsed output", () => {
		const result = SupervisorConfigSchema.parse(validMinimal);
		// These fields have .default() and must be non-optional in result
		assert.equal(typeof result.maxRejections, "number");
		assert.equal(typeof result.ciGatingTimeoutSec, "number");
		assert.equal(typeof result.bellOnComplete, "boolean");
		assert.equal(typeof result.enableExperimentalFeatures, "boolean");
		assert.equal(typeof result.auditScoreThreshold, "number");
		assert.equal(typeof result.statusField, "string");
		assert.equal(typeof result.defaultBranch, "string");
		assert.equal(typeof result.remote, "string");
		assert.equal(typeof result.worktreeBase, "string");
		assert.equal(typeof result.branchPrefix, "string");
		assert.equal(typeof result.vulnGateBlocking, "boolean");
		assert.equal(typeof result.vulnGateTimeoutSec, "number");
	});

	it("Optional fields without .default() may be undefined", () => {
		const result = SupervisorConfigSchema.parse(validMinimal);
		assert.equal(result.agentTokenBudget, undefined);
		assert.equal(result.maxToolCalls, undefined);
		assert.equal(result.submodules, undefined);
		assert.equal(result.agentTimeoutsMin, undefined);
	});
});
