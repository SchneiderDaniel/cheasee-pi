/**
 * Integration: the web_crawl tool contract survives the real SDK loader.
 *
 * Layer: integration — uses the real @earendil-works/pi-coding-agent jiti
 * loader (no model, no network, no provider config, no subprocess). This is
 * the registration path that surfaces `annotations`/`outputSchema` to the
 * runtime; those fields do not exist on the 0.79.x ToolDefinition.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createAgentSession,
	discoverAndLoadExtensions,
	SessionManager,
	type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

const EXT_ENTRY = resolve(import.meta.dirname, "../index.ts");

let sandbox: string;
let loaded: LoadExtensionsResult;

before(async () => {
	// Sandbox cwd + agentDir so discovery scans nothing but our explicit path.
	sandbox = mkdtempSync(join(tmpdir(), "scrapling-annotations-"));
	loaded = await discoverAndLoadExtensions([EXT_ENTRY], sandbox, sandbox);
});

after(() => {
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function webCrawlDefinition() {
	assert.deepEqual(loaded.errors, [], "web_crawl extension should load without errors");
	const ext = loaded.extensions[0];
	assert.ok(ext, "one extension should be loaded");
	const defined = ext.tools.get("web_crawl");
	assert.ok(defined, "web_crawl should be registered");
	return defined.definition;
}

describe("web_crawl annotations — real SDK loader round-trip", () => {
	it("(integration) definition carries readOnlyHint + openWorldHint", () => {
		assert.deepEqual(webCrawlDefinition().annotations, {
			readOnlyHint: true,
			openWorldHint: true,
		});
	});

	it("(integration) definition carries a JSON-serializable outputSchema", () => {
		const schema = webCrawlDefinition().outputSchema;
		assert.ok(schema, "outputSchema should be present");
		const roundTripped = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
		assert.equal(typeof roundTripped, "object");
	});
});

describe("web_crawl annotations — pi.getAllTools() runtime surface", () => {
	it("(integration) getAllTools() reports readOnlyHint + openWorldHint for web_crawl", async () => {
		// Feed the real loaded definition into a real AgentSession and read it back
		// through getAllTools() — the runtime path permission tooling consumes. This
		// is the behavior absent on 0.79.x, where getAllTools() drops annotations.
		const { session } = await createAgentSession({
			cwd: sandbox,
			agentDir: sandbox,
			sessionManager: SessionManager.inMemory(),
			customTools: [webCrawlDefinition()],
		});

		const info = session.getAllTools().find((t) => t.name === "web_crawl");
		assert.ok(info, "web_crawl should be reported by getAllTools()");
		assert.deepEqual(info.annotations, { readOnlyHint: true, openWorldHint: true });
	});
});

describe("runtime pin — pi 1.0.2 lockstep", () => {
	it("(infra) package.json pins all three @earendil-works/pi-* to exactly 1.0.2", () => {
		const pkgPath = resolve(import.meta.dirname, "../../../../package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
			dependencies: Record<string, string>;
		};
		for (const name of [
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
		]) {
			assert.equal(pkg.dependencies[name], "1.0.2", `${name} must be pinned to exactly 1.0.2`);
		}
	});

	it("(infra) package-lock.json locks the same exact @earendil-works/pi-* versions", () => {
		const lockPath = resolve(import.meta.dirname, "../../../../package-lock.json");
		const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
			packages: Record<string, { dependencies?: Record<string, string> }>;
		};
		const root = lock.packages[""];
		assert.ok(root?.dependencies, "package-lock root package must declare dependencies");
		for (const name of [
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
		]) {
			assert.equal(root.dependencies![name], "1.0.2", `${name} must be pinned in package-lock root`);
		}
	});
});
