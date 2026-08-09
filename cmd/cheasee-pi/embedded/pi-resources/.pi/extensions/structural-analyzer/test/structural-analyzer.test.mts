/**
 * Tests: structural-analyzer manifest cleanup + binary prerequisites
 *
 * Verifies that @earendil-works/pi-ai zombie peer dependency is removed.
 * Also verifies ast-grep binary is installed (prerequisite for extension).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, "..", "package.json");

describe("structural-analyzer manifest", () => {
	let pkg: Record<string, unknown>;
	let raw: string;

	it("package.json parses as valid JSON (no syntax error)", () => {
		raw = readFileSync(packageJsonPath, "utf-8");
		pkg = JSON.parse(raw);
	});

	it("peerDependencies is an object", () => {
		const peerDeps = pkg.peerDependencies;
		assert.ok(peerDeps !== null && typeof peerDeps === "object" && !Array.isArray(peerDeps));
	});

	it("peerDependencies has exactly two entries: @earendil-works/pi-coding-agent and typebox", () => {
		const peerDeps = pkg.peerDependencies as Record<string, string>;
		const keys = Object.keys(peerDeps);
		assert.strictEqual(
			keys.length,
			2,
			`Expected 2 peer deps, got ${keys.length}: ${keys.join(", ")}`,
		);
		assert.ok("@earendil-works/pi-coding-agent" in peerDeps);
		assert.ok("typebox" in peerDeps);
	});

	it("@earendil-works/pi-ai is absent from peerDependencies (not a key)", () => {
		const peerDeps = pkg.peerDependencies as Record<string, string>;
		assert.ok(!("@earendil-works/pi-ai" in peerDeps));
	});

	it("@earendil-works/pi-ai appears 0 times in the raw file content (string-level guard)", () => {
		const count = (raw.match(/@earendil-works\/pi-ai/g) || []).length;
		assert.strictEqual(count, 0, `Expected 0 occurrences of @earendil-works/pi-ai, found ${count}`);
	});

	it('remaining peer dep entries preserve their "*" range strings unchanged', () => {
		const peerDeps = pkg.peerDependencies as Record<string, string>;
		assert.strictEqual(peerDeps["@earendil-works/pi-coding-agent"], "*");
		assert.strictEqual(peerDeps["typebox"], "*");
	});
});

describe("ast-grep binary prerequisite", () => {
	const BINARY_CANDIDATES = ["ast-grep", "sg"];

	it("ast-grep binary is installed and executable (via $PATH)", () => {
		let found = false;
		let version = "";
		for (const bin of BINARY_CANDIDATES) {
			try {
				version = execSync(`${bin} --version`, {
					encoding: "utf-8",
					timeout: 5_000,
				})
					.trim()
					.split("\n")[0];
				found = true;
				break;
			} catch {
				continue;
			}
		}

		assert.ok(
			found,
			"ast-grep is not installed or not found in $PATH. " +
				"Install it globally: npm i -g @ast-grep/cli\n" +
				"Also ensure npm global bin dir (typically ~/.npm-global/bin " +
				"or $(npm config get prefix)/bin) is in your $PATH.",
		);

		// Version string sanity check: should contain semver
		const versionMatch = version.match(/(\d+\.\d+\.\d+)/);
		assert.ok(
			versionMatch,
			`ast-grep --version output "${version}" should contain a semver string`,
		);
		const semver = versionMatch[1];
		const parts = semver.split(".").map(Number);
		assert.ok(parts[0] >= 0, `ast-grep major version should be >= 0, got ${parts[0]}`);
	});

	it("ast-grep binary also locatable via npm prefix (defense against PATH gaps)", () => {
		try {
			const prefix = execSync("npm config get prefix", {
				encoding: "utf-8",
				timeout: 3_000,
			}).trim();
			assert.ok(prefix, "npm prefix should not be empty");

			const binPath = resolve(prefix, "bin", "ast-grep");
			const exists = existsSync(binPath);

			if (!exists) {
				// Try sg as alternative
				const sgPath = resolve(prefix, "bin", "sg");
				assert.ok(
					existsSync(sgPath),
					`ast-grep binary not found at npm prefix bin dir: ${binPath}\n` +
						`Also checked: ${sgPath}\n` +
						`npm prefix: ${prefix}\n` +
						"This means ast-grep is not installed globally, or npm prefix is misconfigured.",
				);
			}
		} catch (err) {
			// npm command itself may not be available in constrained environments
			// This is a soft check — skip if npm is not accessible
			if ((err as any)?.code === "ENOENT") {
				console.warn("npm not available, skipping npm prefix check");
				return;
			}
			throw err;
		}
	});
});
