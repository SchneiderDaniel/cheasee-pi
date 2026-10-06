/**
 * Tests for .pi/extensions/codeflow-analysis/index.ts — HTTP transport and the
 * `ignore/codeflow-report.md` artifact.
 *
 * A real `node:http` shim stands in for the codeflow container; the fetch
 * factory is pointed at it so request counting and status handling are
 * exercised end to end. No Docker and no live CodeFlow.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/codeflow-analysis/test/codeflow-analysis.test.mts
 */

import assert from "node:assert";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import codeflowAnalysis, {
	fetchAndStoreReport,
	parseAnalyzedAt,
	REPORT_REL_PATH,
	resetReportCache,
	setFetchFactory,
	setWriteFileFactory,
} from "../index.ts";
import { groupIssues, parseReport } from "../report.ts";

// ── Mock shim ───────────────────────────────────

interface Shim {
	base: string;
	count(): number;
	close(): Promise<void>;
}

async function startShim(opts: { status?: number; body?: string; analyzedAt?: string | null }): Promise<Shim> {
	let count = 0;
	const server: Server = createServer((_req, res) => {
		count++;
		const status = opts.status ?? 200;
		res.statusCode = status;
		if (status === 200) {
			res.setHeader("Content-Type", "text/markdown; charset=utf-8");
			if (opts.analyzedAt !== undefined && opts.analyzedAt !== null) {
				res.setHeader("X-Codeflow-Analysis-At", opts.analyzedAt);
			}
			res.end(opts.body ?? "");
		} else {
			res.end("err");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	return {
		base: `http://127.0.0.1:${port}`,
		count: () => count,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** Point the extension's fetch factory at a mock base, preserving the path. */
function routeTo(shim: Shim): void {
	setFetchFactory((url, init) => fetch(shim.base + new URL(url).pathname, init));
}

// ── Mock pi ─────────────────────────────────────

function makePi(): any {
	let tool: any = null;
	const pi: any = {
		registerTool: (t: any) => {
			tool = t;
		},
		on: () => {},
	};
	pi.__tool = () => tool;
	return pi;
}

async function execTool(pi: any, params: any, opts?: { cwd?: string; signal?: AbortSignal }): Promise<any> {
	const tool = pi.__tool();
	return tool.execute("call-1", params, opts?.signal, undefined, { cwd: opts?.cwd });
}

// ── Fixtures ────────────────────────────────────

let cwd: string;
let shims: Shim[] = [];

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "codeflow-analysis-"));
	resetReportCache();
});

afterEach(async () => {
	setFetchFactory();
	setWriteFileFactory();
	resetReportCache();
	await Promise.all(shims.map((s) => s.close()));
	shims = [];
});

async function shim(opts: Parameters<typeof startShim>[0]): Promise<Shim> {
	const s = await startShim(opts);
	shims.push(s);
	return s;
}

const REPORT_PATH = () => join(cwd, REPORT_REL_PATH);
const tmpFiles = () => {
	const dir = join(cwd, "ignore");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".tmp"));
};

// ── Tool registration ───────────────────────────

describe("codeflowAnalysis extension wiring", () => {
	it("registers the codeflow_analysis_report tool with a refresh param", () => {
		const pi = makePi();
		codeflowAnalysis(pi);
		const tool = pi.__tool();
		assert.ok(tool, "tool should be registered");
		assert.strictEqual(tool.name, "codeflow_analysis_report");
		assert.ok(tool.parameters.properties.refresh, "refresh param should exist");
	});
});

describe("transport + artifact", () => {
	it("writes the report and returns path/bytes/analyzedAt", async () => {
		const body = "# CodeFlow Analysis Report\n\n## Architecture Issues\n";
		const s = await shim({ status: 200, body, analyzedAt: "1767225600000" });
		routeTo(s);

		const pi = makePi();
		codeflowAnalysis(pi);
		const res = await execTool(pi, {}, { cwd });

		const target = REPORT_PATH();
		assert.ok(existsSync(target), "report file should exist");
		assert.strictEqual(readFileSync(target, "utf-8"), body);
		assert.strictEqual(res.details.path, target);
		assert.strictEqual(res.details.bytes, Buffer.byteLength(body));
		assert.strictEqual(res.details.analyzedAt, 1767225600000);
		assert.ok(res.details.path.startsWith(cwd), "path must resolve inside cwd");
	});

	it("returns an actionable error and leaves a pre-existing report intact on 404", async () => {
		const s = await shim({ status: 404 });
		routeTo(s);
		const target = REPORT_PATH();
		mkdirSync(join(cwd, "ignore"), { recursive: true });
		writeFileSync(target, "PRE-EXISTING");

		const pi = makePi();
		codeflowAnalysis(pi);
		const res = await execTool(pi, {}, { cwd });

		assert.strictEqual(res.isError, true);
		assert.match(res.content[0].text, /run analysis in CodeFlow/);
		assert.strictEqual(readFileSync(target, "utf-8"), "PRE-EXISTING");
	});

	it("surfaces a 500 and writes no file", async () => {
		const s = await shim({ status: 500 });
		routeTo(s);
		const pi = makePi();
		codeflowAnalysis(pi);
		const res = await execTool(pi, {}, { cwd });
		assert.strictEqual(res.isError, true);
		assert.match(res.content[0].text, /HTTP 500/);
		assert.ok(!existsSync(REPORT_PATH()));
	});

	it("rejects on a refused connection", async () => {
		setFetchFactory((url, init) => fetch("http://127.0.0.1:1" + new URL(url).pathname, init));
		await assert.rejects(() => fetchAndStoreReport({ cwd }), /CodeFlow request failed/);
		assert.ok(!existsSync(REPORT_PATH()));
	});

	it("rejects on abort and leaves no temp file", async () => {
		setFetchFactory(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		const controller = new AbortController();
		const promise = fetchAndStoreReport({ cwd, signal: controller.signal });
		controller.abort();
		await assert.rejects(() => promise);
		assert.ok(!existsSync(REPORT_PATH()));
		assert.deepStrictEqual(tmpFiles(), []);
	});

	it("cleans the temp file when the write fails and keeps the old report", async () => {
		const s = await shim({ status: 200, body: "NEW" });
		routeTo(s);
		mkdirSync(join(cwd, "ignore"), { recursive: true });
		writeFileSync(REPORT_PATH(), "OLD");
		setWriteFileFactory(() => {
			throw new Error("disk full");
		});
		await assert.rejects(() => fetchAndStoreReport({ cwd }), /disk full/);
		assert.strictEqual(readFileSync(REPORT_PATH(), "utf-8"), "OLD");
		assert.deepStrictEqual(tmpFiles(), []);
	});

	it("reports analyzedAt null for a missing or malformed header", async () => {
		for (const analyzedAt of [null, "not-a-number"]) {
			resetReportCache();
			const s = await shim({ status: 200, body: "BODY", analyzedAt });
			routeTo(s);
			const outcome = await fetchAndStoreReport({ cwd, refresh: true });
			assert.strictEqual(outcome.ok, true);
			assert.strictEqual(outcome.ok && outcome.result.analyzedAt, null);
		}
	});
});

describe("parseAnalyzedAt", () => {
	it("parses epoch-ms and rejects absent/blank/malformed values", () => {
		assert.strictEqual(parseAnalyzedAt("1767225600000"), 1767225600000);
		for (const bad of [null, undefined, "", "  ", "abc", "0", "-5"]) {
			assert.strictEqual(parseAnalyzedAt(bad as any), null);
		}
	});
});

describe("session cache", () => {
	it("serves the second call from cache and re-fetches on refresh", async () => {
		const s = await shim({ status: 200, body: "BODY", analyzedAt: "1767225600000" });
		routeTo(s);
		await fetchAndStoreReport({ cwd });
		await fetchAndStoreReport({ cwd });
		assert.strictEqual(s.count(), 1, "second call must hit the cache");
		await fetchAndStoreReport({ cwd, refresh: true });
		assert.strictEqual(s.count(), 2, "refresh must bypass the cache");
	});
});

// ── Phase 6 e2e: real server.py subprocess ──────

const PYTHON = (() => {
	try {
		execFileSync("python3", ["--version"], { stdio: "ignore" });
		return "python3";
	} catch {
		return null;
	}
})();

function waitForExit(proc: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
		proc.once("exit", () => resolve());
	});
}

describe("e2e: real codeflow shim subprocess", () => {
	it("404s before analysis, then round-trips the fixture into a grouped plan", async (t) => {
		if (!PYTHON) return t.skip("python3 not available");

		const publicDir = mkdtempSync(join(tmpdir(), "codeflow-e2e-"));
		// Any free port works; the shim binds HOST/PORT from env.
		const port = await new Promise<number>((resolvePort) => {
			const srv = createServer();
			srv.listen(0, "127.0.0.1", () => {
				const p = (srv.address() as AddressInfo).port;
				srv.close(() => resolvePort(p));
			});
		});

		const serverPath = resolve(
			import.meta.dirname,
			"..",
			"..",
			"..",
			"..",
			"cmd/cheasee-pi/embedded/docker/codeflow/server.py",
		);
		let log = "";
		const proc = spawn(PYTHON, [serverPath], {
			env: {
				...process.env,
				REPO_ROOT: publicDir,
				UI_DIR: publicDir,
				CONFIG_FILE: join(publicDir, "missing-config.json"),
				PORT: String(port),
				HOST: "127.0.0.1",
				PYTHONUNBUFFERED: "1",
			},
		});
		proc.stdout?.on("data", (d) => (log += d.toString()));
		proc.stderr?.on("data", (d) => (log += d.toString()));
		const base = `http://127.0.0.1:${port}`;
		routeTo({ base, count: () => 0, close: async () => {} });

		const deadline = Date.now() + 15_000;
		for (;;) {
			try {
				const r = await fetch(base + "/api/repos/o/r");
				if (r.ok) break;
			} catch {
				/* not up yet */
			}
			if (Date.now() > deadline) throw new Error(`shim did not start:\n${log}`);
			await new Promise((r) => setTimeout(r, 100));
		}

		try {
			// Before the browser bridge POSTs, the tool must report the actionable 404.
			const miss = await fetchAndStoreReport({ cwd, refresh: true });
			assert.strictEqual(miss.ok, false);
			assert.match(miss.ok === false ? miss.message : "", /run analysis in CodeFlow/);

			// Simulate the browser bridge: POST the captured fixture markdown.
			const fixture = readFileSync(join(import.meta.dirname, "fixtures", "codeflow-report.md"), "utf-8");
			const posted = await fetch(base + "/api/analysis/report", {
				method: "POST",
				headers: { "Content-Type": "text/markdown; charset=utf-8" },
				body: fixture,
			});
			assert.strictEqual(posted.status, 204);

			const outcome = await fetchAndStoreReport({ cwd, refresh: true });
			assert.strictEqual(outcome.ok, true);
			assert.strictEqual(readFileSync(REPORT_PATH(), "utf-8"), fixture);

			// The fixture groups into groups whose file sets are pairwise disjoint.
			const groups = groupIssues(parseReport(fixture));
			assert.ok(groups.length >= 1, "fixture must yield at least one group");
			const groupFiles = groups.map((g) => new Set(g.issues.flatMap((i) => i.files)));
			for (let a = 0; a < groupFiles.length; a++) {
				for (let b = a + 1; b < groupFiles.length; b++) {
					for (const f of groupFiles[a]) {
						assert.ok(!groupFiles[b].has(f), `file ${f} shared across two groups`);
					}
				}
			}
		} finally {
			proc.kill("SIGKILL");
			await waitForExit(proc);
			assert.ok(!log.includes("Traceback"), `shim logged a traceback:\n${log}`);
		}
	});
});
