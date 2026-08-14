/**
 * End-to-end tests for the scrapling crawler (web_crawl).
 *
 * Spawns the REAL inline crawl script (SCRAPLING_SCRIPT) as a subprocess with the
 * actual scrapling venv, against local http servers — no external network needed.
 *
 * Tier coverage:
 *   - lightweight: local 200 page → Fetcher.get path (no browser)
 *   - stealth:     local 403 page → StealthyFetcher path (launches patchright chromium)
 *
 * Skip policy: the stealth describe skips when patchright's chromium build is not
 * installed (dev machines / pre-fix images). The regression gate for a missing
 * browser lives in the Dockerfile build (fatal ls on the chromium-* binary path,
 * layer 5e) plus the Dockerfile-contract test below — so a missing browser
 * is caught at image build, never silently shipped again. The revision test inside
 * the stealth describe fails LOUDLY when a chromium build exists but is the wrong
 * revision (playwright 1234 vs patchright 1228 — issue 1529 root cause 1).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { SCRAPLING_SCRIPT } from "../python-script.ts";

// ── Environment resolution ──

const REPO_ROOT = process.cwd();
const VENV_PYTHON = path.join(REPO_ROOT, ".pi", "scrapling-venv", "bin", "python3");
const VENV_ROOT = path.dirname(path.dirname(VENV_PYTHON));
const hasVenv = existsSync(VENV_PYTHON);
const NO_VENV_MSG = "scrapling venv missing — run npm install? (web_crawl venv not prebuilt here)";

function patchrightChromiumRevision(python: string): string | null {
	const res = spawnSync(
		python,
		[
			"-c",
			[
				"import json, glob",
				`d = json.load(open(glob.glob('${VENV_ROOT}/lib/python*/site-packages/patchright/driver/package/browsers.json')[0]))`,
				"print(next(b['revision'] for b in d['browsers'] if b['name'] == 'chromium'))",
			].join("; "),
		],
		{ encoding: "utf8", timeout: 15_000 },
	);
	if (res.status !== 0) return null;
	return res.stdout.trim();
}

function browserRoot(): string {
	return process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), ".cache", "ms-playwright");
}

const revision = hasVenv ? patchrightChromiumRevision(VENV_PYTHON) : null;
const chromiumPath = revision
	? path.join(browserRoot(), `chromium-${revision}`, "chrome-linux64", "chrome")
	: null;
const hasChromium = chromiumPath !== null && existsSync(chromiumPath);
const NO_CHROMIUM_MSG = `patchright chromium (rev ${revision ?? "?"}) not installed at ${browserRoot()}/chromium-${revision ?? "?"} — run: ${VENV_PYTHON} -m patchright install chromium (or rebuild the Docker image; layer 5e fails the build when it's missing)`;

// ── Local http server helpers ──

function startServer(status: number, body: string): Promise<{ port: number; close: () => void }> {
	const server: Server = http.createServer((_req, res) => {
		res.writeHead(status, { "Content-Type": "text/html" });
		res.end(body);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ port, close: () => server.close() });
		});
	});
}

interface CrawlResult {
	ok: boolean;
	results: Array<{
		url: string;
		markdown?: string;
		method?: string;
		success: boolean;
		error?: string;
	}>;
}

/**
 * Run the real crawl script as a subprocess, ASYNC.
 * Must be async: spawnSync would block this process's event loop, freezing the
 * in-process local http server — curl_cffi then gets "0 bytes received" and
 * times out after 15s. Async spawn keeps the server responsive.
 */
function runCrawl(url: string): Promise<CrawlResult> {
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(
			VENV_PYTHON,
			["-c", SCRAPLING_SCRIPT, JSON.stringify({ url, maxPages: 1 })],
			{ timeout: 120_000 },
		);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d: Buffer) => (stdout += d));
		child.stderr?.on("data", (d: Buffer) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code !== 0) {
				reject(
					new Error(
						`crawler exited code=${code} signal=${signal}: ${(stderr || stdout).slice(0, 800)}`,
					),
				);
				return;
			}
			try {
				resolve(JSON.parse(stdout) as CrawlResult);
			} catch {
				reject(new Error(`invalid crawl JSON: ${(stderr || stdout).slice(0, 400)}`));
			}
		});
	});
}

// ══════════════════════════════════════════════════════════════════
//  Tests
// ══════════════════════════════════════════════════════════════════

describe("scrapling venv — verify", { skip: hasVenv ? false : NO_VENV_MSG }, () => {
	it("(entity) venv verify command passes (imports scrapling.fetchers + markdownify)", () => {
		const res = spawnSync(
			VENV_PYTHON,
			["-c", "from scrapling.fetchers import StealthyFetcher; import markdownify; print('ok')"],
			{ encoding: "utf8", timeout: 30_000 },
		);
		assert.equal(res.status, 0, `verify failed: ${res.stderr}`);
		assert.match(res.stdout, /ok/, "verify should print ok");
	});
});

describe("scrapling image contract — Dockerfile layer 5e", () => {
	it("(entity) Dockerfile installs patchright chromium (rev 1228, not playwright 1234)", () => {
		const df = readFileSync(
			path.join(REPO_ROOT, "cmd", "cheasee-pi", "embedded", "docker", "Dockerfile"),
			"utf8",
		);
		assert.match(
			df,
			/python -m patchright install chromium/,
			"must install chromium via patchright — playwright's build never matches StealthyFetcher's revision",
		);
		assert.match(
			df,
			/chromium-\*\/chrome-linux64\/chrome/,
			"must fail the image build when chromium is missing (silent-build-failure regression, issue 1529)",
		);
	});
});

describe("web_crawl e2e — lightweight tier", { skip: hasVenv ? false : NO_VENV_MSG }, () => {
	it("(e2e) fetches a plain 200 page via Fetcher.get and returns markdown", async () => {
		const { port, close } = await startServer(
			200,
			"<html><body><h1>LIGHTWEIGHTMARKER7F3A</h1></body></html>",
		);
		try {
			const result = await runCrawl(`http://127.0.0.1:${port}/`);
			assert.equal(result.ok, true);
			assert.equal(result.results.length, 1);
			assert.equal(result.results[0].success, true);
			assert.equal(result.results[0].method, "lightweight");
			assert.match(result.results[0].markdown ?? "", /LIGHTWEIGHTMARKER7F3A/);
		} finally {
			close();
		}
	});
});

describe(
	"web_crawl e2e — stealth tier (patchright chromium)",
	{ skip: hasVenv && hasChromium ? false : hasVenv ? NO_CHROMIUM_MSG : NO_VENV_MSG },
	() => {
		it("(e2e) chromium revision matches patchright browsers.json", () => {
			// Root cause 1 of issue 1529: playwright's chromium (1234) installed while
			// StealthyFetcher launches patchright's (1228). Presence of ANY chromium-*
			// dir is not enough — the revision must match.
			const chromiumDirs = readdirSync(browserRoot()).filter((d) => d.startsWith("chromium-"));
			assert.ok(
				chromiumDirs.some((d) => d === `chromium-${revision}`),
				`installed chromium dirs [${chromiumDirs.join(", ")}] do not include chromium-${revision} (patchright rev) — playwright's build was installed instead`,
			);
		});

		it("(e2e) fetches a blocked 403 page via StealthyFetcher (real chromium launch) and returns markdown", async () => {
			const { port, close } = await startServer(
				403,
				"<html><body><h1>STEALTHMARKER9C21</h1></body></html>",
			);
			try {
				const result = await runCrawl(`http://127.0.0.1:${port}/`);
				assert.equal(result.ok, true);
				assert.equal(result.results.length, 1);
				assert.equal(
					result.results[0].success,
					true,
					`stealth fetch failed: ${result.results[0].error ?? "no error"}`,
				);
				assert.equal(result.results[0].method, "stealth");
				assert.match(result.results[0].markdown ?? "", /STEALTHMARKER9C21/);
			} finally {
				close();
			}
		});
	},
);
