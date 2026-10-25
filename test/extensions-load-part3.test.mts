import assert from "node:assert";

import { describe, it } from "node:test";

import { readdirSync, existsSync, readFileSync } from "node:fs";

import { join, resolve } from "node:path";

const EXTENSIONS_DIR = resolve(import.meta.dirname, "..", ".pi/extensions");

interface ExtensionEntry {
	name: string;
	dir: string;
	entryPoint: string | null;
	hasPackageJson: boolean;
	hasPackageJsonExtensions: boolean;
}

function discoverExtensions(): ExtensionEntry[] {
	if (!existsSync(EXTENSIONS_DIR)) return [];

	const entries = readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
	const extensions: ExtensionEntry[] = [];

	// Directories inside .pi/extensions/ that are shared libraries, not extensions
	const SKIP_DIRS = new Set(["lib"]);

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (SKIP_DIRS.has(entry.name)) continue;

		const dir = join(EXTENSIONS_DIR, entry.name);
		const indexTs = join(dir, "index.ts");
		const indexJs = join(dir, "index.js");
		const pkgJson = join(dir, "package.json");

		const hasPkg = existsSync(pkgJson);
		let pkgExts = false;
		if (hasPkg) {
			try {
				const pkg = JSON.parse(readFileSync(pkgJson, "utf-8"));
				pkgExts = !!pkg.pi?.extensions?.length;
			} catch {
				// invalid JSON — handled in manifest phase
			}
		}

		let entryPoint: string | null = null;
		if (pkgExts) {
			// Use the first declared extension path from package.json
			try {
				const pkg = JSON.parse(readFileSync(pkgJson, "utf-8"));
				entryPoint = resolve(dir, pkg.pi.extensions[0]);
			} catch {
				// fall through to index.ts check
			}
		}
		if (!entryPoint && existsSync(indexTs)) entryPoint = indexTs;
		if (!entryPoint && existsSync(indexJs)) entryPoint = indexJs;

		extensions.push({
			name: entry.name,
			dir,
			entryPoint,
			hasPackageJson: hasPkg,
			hasPackageJsonExtensions: pkgExts,
		});
	}

	return extensions;
}

const SDK_SCOPE = "@earendil-works/";

function collectExtensionSources(): { file: string; source: string }[] {
	const extsDir = resolve(import.meta.dirname, "..", ".pi/extensions");
	const out: { file: string; source: string }[] = [];
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && entry.name !== "fixtures") walk(full);
			} else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mts"))) {
				out.push({ file: full, source: readFileSync(full, "utf-8") });
			}
		}
	};
	walk(extsDir);
	return out;
}

describe("Phase 7: SDK static import resolution guard", () => {
	describe("Phase 3: regression", () => {
		const runnerSpecifier = "../.pi/extensions/supervisor/agent/agent-session-runner.ts";
		const runnerPath = resolve(
			import.meta.dirname,
			"..",
			".pi/extensions/supervisor/agent/agent-session-runner.ts",
		);

		it("agent-session-runner.ts loads and exports runAgentInProcess", async () => {
			const mod = (await import(runnerSpecifier)) as Record<string, unknown>;
			assert.strictEqual(
				typeof mod.runAgentInProcess,
				"function",
				"agent-session-runner.ts must load and export runAgentInProcess (P0 regression)",
			);
		});

		it("production runner keeps the resolvable providers/all import", () => {
			const source = readFileSync(runnerPath, "utf-8");
			assert.match(
				source,
				/import \{ getBuiltinModel \} from "@earendil-works\/pi-ai\/providers\/all"/,
				"runner must import getBuiltinModel from providers/all",
			);
			assert.doesNotMatch(
				source,
				/import \{[^}]*\bgetModel\b[^}]*\} from "@earendil-works\/pi-ai"/,
				"runner must not import getModel from the pi-ai root (nonexistent export)",
			);
		});
	});
});
