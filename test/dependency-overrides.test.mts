// ─── Transitive dependency advisory pins ──────────────────────────
// `minimatch` < 11.0.1 is affected by GHSA-g3hv-75wg-m249 (CVE-2026-118764):
// globparts amplification in first-phase preprocessing, quadratic second-phase
// processing — CPU/memory exhaustion for a caller that hands a glob pattern to
// minimatch. No 10.x release is patched, so the fix is an override to 11.0.1.
//
// The pins live in `package.json` `overrides` because the parents disagree on the
// range (`@earendil-works/pi-coding-agent` pins 10.2.6 exactly, `eslint` asks for
// ^10.2.5) and neither can reach a fixed release on its own. This guard keeps the
// resolution honest: it reads the committed files, so it needs no install step.
//
// Run: node --experimental-strip-types --test test/dependency-overrides.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** GHSA-g3hv-75wg-m249 / CVE-2026-118764: affected from 7.0.0, fixed in 11.0.1. */
const MINIMATCH_AFFECTED_FROM = "7.0.0";
const MINIMATCH_FIXED = "11.0.1";

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf-8");
const readJson = <T,>(rel: string): T => JSON.parse(read(rel)) as T;

type Semver = readonly [number, number, number];

/** Parse a plain `X.Y.Z` version. Prereleases are rejected on purpose: an
 *  advisory pin names a released, patched version, never a candidate. */
function parseVersion(version: unknown, label: string): Semver {
	assert.equal(typeof version, "string", `${label} must be a plain version string`);
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version as string);
	assert.ok(match, `${label} must be a plain X.Y.Z version, got ${JSON.stringify(version)}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const compare = (a: Semver, b: Semver): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const below = (version: Semver, bound: Semver): boolean => compare(version, bound) < 0;

interface PackageJson {
	overrides?: Record<string, unknown>;
}

interface Lockfile {
	packages?: Record<string, { version?: string }>;
}

const overrides = (): Record<string, unknown> =>
	readJson<PackageJson>("package.json").overrides ?? {};
const lockedVersion = (name: string): string | undefined =>
	readJson<Lockfile>("package-lock.json").packages?.[`node_modules/${name}`]?.version;

describe("dependency pins — GHSA-g3hv-75wg-m249 (minimatch)", () => {
	it("the version comparison used below is sound", () => {
		// Teeth: the guard must be able to tell an affected version from a fixed one.
		assert.ok(below(parseVersion("10.2.6", "sample"), parseVersion(MINIMATCH_FIXED, "sample")));
		assert.equal(
			below(parseVersion("11.0.1", "sample"), parseVersion(MINIMATCH_FIXED, "sample")),
			false,
		);
		assert.ok(
			below(
				parseVersion(MINIMATCH_AFFECTED_FROM, "sample"),
				parseVersion(MINIMATCH_FIXED, "sample"),
			),
		);
	});

	it("package.json pins minimatch as a version, not as a nested object", () => {
		const pin = overrides().minimatch;
		// An object override carries child pins only: it silently drops the version
		// pin this advisory needs, which is exactly how the regression crept in.
		assert.equal(
			typeof pin,
			"string",
			`overrides.minimatch must be a version string, got ${JSON.stringify(pin)}`,
		);
	});

	it("the pinned minimatch is at or above the advisory fix", () => {
		const pinned = parseVersion(overrides().minimatch, "overrides.minimatch");
		const fixed = parseVersion(MINIMATCH_FIXED, "MINIMATCH_FIXED");
		assert.equal(
			below(pinned, fixed),
			false,
			`overrides.minimatch ${overrides().minimatch} is below the fix ${MINIMATCH_FIXED}`,
		);
	});

	it("the lockfile resolves minimatch outside the affected range", () => {
		const locked = lockedVersion("minimatch");
		assert.ok(locked, "package-lock.json must record node_modules/minimatch");
		const version = parseVersion(locked, "locked minimatch");
		const affected = !below(
			version,
			parseVersion(MINIMATCH_AFFECTED_FROM, "MINIMATCH_AFFECTED_FROM"),
		);
		assert.equal(
			affected && below(version, parseVersion(MINIMATCH_FIXED, "MINIMATCH_FIXED")),
			false,
			`package-lock.json resolves minimatch ${locked}, which GHSA-g3hv-75wg-m249 affects`,
		);
	});

	it("minimatch's own helper dependency is pinned as a version", () => {
		// minimatch 11 reaches a second registry package. Left to float, an ordinary
		// `npm install` could resolve a release younger than the 14-day age gate.
		const pin = overrides()["@isaacs/nonrecursive-glob-match"];
		assert.equal(typeof pin, "string", "overrides must pin @isaacs/nonrecursive-glob-match");
		assert.equal(
			lockedVersion("@isaacs/nonrecursive-glob-match"),
			pin,
			"the lockfile must resolve the pinned helper version",
		);
	});

	it("the docs record the pins and the advisory they close", () => {
		const security = read("docs/security.md");
		assert.ok(security.includes("GHSA-g3hv-75wg-m249"), "docs/security.md must name the advisory");
		assert.ok(security.includes(MINIMATCH_FIXED), "docs/security.md must name the fixed version");
	});
});
