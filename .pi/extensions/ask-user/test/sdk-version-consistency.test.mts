/**
 * Guards the audit fixes for issue #1795:
 * - the Pi SDK floor is declared consistently across the root package,
 *   the ask-user peer dependency, and its README;
 * - the project pins `tuiMode` explicitly so the SDK 1.x bump does not
 *   silently switch the TUI to fullscreen and drop terminal scrollback.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ask-user/test/sdk-version-consistency.test.mts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");

function readJson<T>(rel: string): T {
	return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf-8")) as T;
}

const SDK_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
] as const;

describe("Pi SDK floor consistency — issue #1795", () => {
	it("root dependencies declare a 1.x SDK version", () => {
		const pkg = readJson<{ dependencies: Record<string, string> }>("package.json");
		for (const name of SDK_PACKAGES) {
			// Accept either a caret range (^1.x) or an exact pin (1.x.y); both
			// keep the repo on the 1.x SDK. Issue #1794 pins exact 1.0.2.
			assert.match(pkg.dependencies[name], /^\^?1\./, `${name} must track the 1.x SDK`);
		}
	});

	it("ask-user peer dependency matches the documented requirement", () => {
		const ext = readJson<{ peerDependencies: Record<string, string> }>(
			".pi/extensions/ask-user/package.json",
		);
		const readme = fs.readFileSync(
			path.join(repoRoot, ".pi/extensions/ask-user/README.md"),
			"utf-8",
		);
		const peerFloor = ext.peerDependencies["@earendil-works/pi-coding-agent"].replace(/^>=/, "");
		assert.ok(
			readme.includes(`≥ v${peerFloor}`),
			`README must state "≥ v${peerFloor}" to match the peer dependency floor`,
		);
	});
});

describe("TUI mode is pinned explicitly — issue #1795", () => {
	it("project settings preserve the regular (non-fullscreen) TUI", () => {
		const settings = readJson<{ tuiMode?: string }>(".pi/settings.json");
		assert.equal(settings.tuiMode, "regular");
	});
});
