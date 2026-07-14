/**
 * Validate .goreleaser.yml structure and content.
 *
 * Covers:
 *   - YAML parseable with version: 2
 *   - builds[0] targets ./cmd/cheasee-pi with cross-platform matrix
 *   - CGO_ENABLED=0 for static linking
 *   - checksum name_template
 *   - release owner/repo
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const CONFIG_PATH = resolve(import.meta.dirname, "..", ".goreleaser.yml");

interface FormatOverride {
	goos: string;
	formats: string[];
}

interface GoReleaserConfig {
	version: number;
	before?: { hooks: string[] };
	builds: Array<{
		main: string;
		env: string[];
		goos: string[];
		goarch: string[];
	}>;
	archives?: Array<{
		name_template: string;
		formats: string[];
		format_overrides?: FormatOverride[];
		files: string[];
	}>;
	checksum?: { name_template: string };
	release?: { github: { owner: string; name: string } };
}

function parseConfig(): GoReleaserConfig {
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	return load(raw) as GoReleaserConfig;
}

describe(".goreleaser.yml", () => {
	describe("Phase 1: File existence and YAML validity", () => {
		it("exists as a regular file", () => {
			assert.ok(existsSync(CONFIG_PATH), ".goreleaser.yml not found");
		});

		it("parses as valid YAML with version: 2 at root", () => {
			const config = parseConfig();
			assert.strictEqual(config.version, 2, "version must be 2");
		});
	});

	describe("Phase 2: Build configuration", () => {
		it("builds[0].main is ./cmd/cheasee-pi", () => {
			const config = parseConfig();
			assert.ok(config.builds, "builds section missing");
			assert.ok(config.builds.length > 0, "no builds defined");
			assert.strictEqual(config.builds[0].main, "./cmd/cheasee-pi");
		});

		it("builds[0].goos contains all target OSes", () => {
			const config = parseConfig();
			assert.ok(config.builds[0].goos.includes("linux"), "missing linux in goos");
			assert.ok(config.builds[0].goos.includes("darwin"), "missing darwin in goos");
			assert.ok(config.builds[0].goos.includes("windows"), "missing windows in goos");
		});

		it("builds[0].goarch contains amd64 and arm64", () => {
			const config = parseConfig();
			assert.ok(config.builds[0].goarch.includes("amd64"), "missing amd64 in goarch");
			assert.ok(config.builds[0].goarch.includes("arm64"), "missing arm64 in goarch");
		});

		it("builds[0].env includes CGO_ENABLED=0", () => {
			const config = parseConfig();
			assert.ok(config.builds[0].env.includes("CGO_ENABLED=0"), "missing CGO_ENABLED=0");
		});
	});

	describe("Phase 3: Archive configuration", () => {
		it("archives[0].format_overrides includes windows with zip format", () => {
			const config = parseConfig();
			assert.ok(config.archives, "archives section missing");
			assert.ok(config.archives.length > 0, "no archives defined");
			const overrides = config.archives[0].format_overrides;
			assert.ok(overrides, "format_overrides missing in archives[0]");
			const winOverride = overrides.find((o) => o.goos === "windows");
			assert.ok(winOverride, "missing format_override for windows");
			assert.ok(winOverride.formats.includes("zip"), "windows format_override must include zip");
		});
	});

	describe("Phase 4: Checksum configuration", () => {
		it("checksum name_template is checksums.txt", () => {
			const config = parseConfig();
			assert.ok(config.checksum, "checksum section missing");
			assert.strictEqual(config.checksum.name_template, "checksums.txt");
		});
	});

	describe("Phase 5: Release target", () => {
		it("release.github.owner is SchneiderDaniel", () => {
			const config = parseConfig();
			assert.ok(config.release, "release section missing");
			assert.ok(config.release.github, "release.github section missing");
			assert.strictEqual(config.release.github.owner, "SchneiderDaniel");
		});

		it("release.github.name is cheasee-pi", () => {
			const config = parseConfig();
			assert.strictEqual(config.release.github.name, "cheasee-pi");
		});
	});
});
