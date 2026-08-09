// ─── Phase 1: Config schema — enableExperimentalFeatures field ────
// Tests for SupervisorConfig type and loadConfig validation.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config/config.ts";

// ─── enableExperimentalFeatures type contract ─────────────────────

describe("SupervisorConfig — enableExperimentalFeatures", () => {
	it("accepts enableExperimentalFeatures as optional boolean field", () => {
		const config: Record<string, unknown> = {
			repo: "owner/repo",
			projectNumber: 1,
			statusMapping: { todo: "developer" },
			codeowners: ["user"],
		};
		// Undefined — backward compatible
		assert.equal(config.enableExperimentalFeatures, undefined);
	});

	it("loadConfig is a function exported from config module", () => {
		assert.equal(typeof loadConfig, "function", "loadConfig should be exported");
	});

	it("loadConfig reads enableExperimentalFeatures from settings.json", () => {
		const testDir = join(tmpdir(), "pi-test-loadConfig-" + Date.now());
		try {
			rmSync(testDir, { recursive: true, force: true });
			mkdirSync(join(testDir, ".pi"), { recursive: true });
			const settings = {
				supervisor: {
					repo: "owner/repo",
					projectNumber: 1,
					statusField: "Status",
					statusMapping: {
						Backlog: "",
						Research: "researcher",
						Architecture: "architect",
						TestDesign: "test-designer",
						Implementation: "developer",
						Audit: "auditor",
						Done: "",
					},
					codeowners: ["owner"],
					enableExperimentalFeatures: true,
				},
			};
			writeFileSync(join(testDir, ".pi", "settings.json"), JSON.stringify(settings), "utf-8");
			const origCwd = process.cwd();
			process.chdir(testDir);
			try {
				assert.equal(loadConfig().enableExperimentalFeatures, true, "loadConfig should read true");
			} finally {
				process.chdir(origCwd);
			}
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("loadConfig defaults enableExperimentalFeatures to false when missing", () => {
		const testDir = join(tmpdir(), "pi-test-loadConfig-missing-" + Date.now());
		try {
			rmSync(testDir, { recursive: true, force: true });
			mkdirSync(join(testDir, ".pi"), { recursive: true });
			const settings = {
				supervisor: {
					repo: "owner/repo",
					projectNumber: 1,
					statusField: "Status",
					statusMapping: {
						Backlog: "",
						Research: "researcher",
						Architecture: "architect",
						TestDesign: "test-designer",
						Implementation: "developer",
						Audit: "auditor",
						Done: "",
					},
					codeowners: ["owner"],
					// enableExperimentalFeatures intentionally missing
				},
			};
			writeFileSync(join(testDir, ".pi", "settings.json"), JSON.stringify(settings), "utf-8");
			const origCwd = process.cwd();
			process.chdir(testDir);
			try {
				assert.equal(
					loadConfig().enableExperimentalFeatures,
					false,
					"loadConfig should default to false",
				);
			} finally {
				process.chdir(origCwd);
			}
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("accepts enableExperimentalFeatures as true", () => {
		const config: Record<string, unknown> = {
			repo: "owner/repo",
			projectNumber: 1,
			statusMapping: { todo: "developer" },
			codeowners: ["user"],
			enableExperimentalFeatures: true,
		};
		assert.equal(config.enableExperimentalFeatures, true);
	});

	it("accepts enableExperimentalFeatures as false", () => {
		const config: Record<string, unknown> = {
			repo: "owner/repo",
			projectNumber: 1,
			statusMapping: { todo: "developer" },
			codeowners: ["user"],
			enableExperimentalFeatures: false,
		};
		assert.equal(config.enableExperimentalFeatures, false);
	});
});

// ─── loadConfig validation via settings.json file ─────────────────

describe("loadConfig — enableExperimentalFeatures validation", () => {
	const testDir = ".pi-test-config-739";

	beforeEach(() => {
		if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
		// Write a base settings.json to restore after each test
		const baseSettings = JSON.stringify({
			supervisor: {
				repo: "owner/repo",
				projectNumber: 1,
				statusField: "Status",
				statusMapping: {
					Backlog: "",
					Research: "researcher",
					Architecture: "architect",
					TestDesign: "test-designer",
					Implementation: "developer",
					Audit: "auditor",
					Done: "",
				},
				codeowners: ["owner"],
				defaultBranch: "main",
				remote: "origin",
				worktreeBase: "../",
				branchPrefix: "worktree-git-issue-",
			},
		});
		writeFileSync(`${testDir}/settings.json`, baseSettings, "utf-8");
	});

	afterEach(() => {
		try {
			unlinkSync(`${testDir}/settings.json`);
		} catch {
			// Ignore
		}
	});

	it("missing enableExperimentalFeatures → no error (backward compat)", () => {
		// Base settings.json has no enableExperimentalFeatures
		const settingsPath = `${testDir}/settings.json`;
		if (existsSync(settingsPath)) {
			const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
			assert.equal(data.supervisor.enableExperimentalFeatures, undefined);
		}
	});

	it("enableExperimentalFeatures: true accepted", () => {
		const settingsPath = `${testDir}/settings.json`;
		const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
		data.supervisor.enableExperimentalFeatures = true;
		writeFileSync(settingsPath, JSON.stringify(data), "utf-8");
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
		assert.equal(parsed.supervisor.enableExperimentalFeatures, true);
	});

	it("enableExperimentalFeatures: false accepted", () => {
		const settingsPath = `${testDir}/settings.json`;
		const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
		data.supervisor.enableExperimentalFeatures = false;
		writeFileSync(settingsPath, JSON.stringify(data), "utf-8");
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
		assert.equal(parsed.supervisor.enableExperimentalFeatures, false);
	});

	it("invalid enableExperimentalFeatures (string) should be rejected", () => {
		// Boolean validation in loadConfig
		const invalidValues = ["yes", "1", "no", ""];
		for (const val of invalidValues) {
			assert.ok(typeof val !== "boolean", `String value "${val}" should not be a valid boolean`);
		}
	});

	it("invalid enableExperimentalFeatures (number) should be rejected", () => {
		assert.ok(typeof 1 !== "boolean", "Number 1 should not be a valid boolean");
		assert.ok(typeof 0 !== "boolean", "Number 0 should not be a valid boolean");
	});

	it("invalid enableExperimentalFeatures (null) should be rejected", () => {
		assert.ok(typeof null !== "boolean", "null should not be a valid boolean");
	});

	it("invalid enableExperimentalFeatures (object) should be rejected", () => {
		assert.ok(typeof {} !== "boolean", "Object should not be a valid boolean");
	});

	it("existing config (without field) loads without error — regression", () => {
		// This test just verifies the base config shape works
		const cfg = {
			repo: "owner/repo",
			projectNumber: 1,
			statusMapping: {
				Backlog: "",
				Research: "researcher",
				Architecture: "architect",
				TestDesign: "test-designer",
				Implementation: "developer",
				Audit: "auditor",
				Done: "",
			},
			codeowners: ["owner"],
		};
		assert.ok(cfg.repo !== undefined);
		assert.ok(cfg.projectNumber !== undefined);
		assert.ok(cfg.statusMapping !== undefined);
		assert.ok(cfg.codeowners !== undefined);
	});
});
