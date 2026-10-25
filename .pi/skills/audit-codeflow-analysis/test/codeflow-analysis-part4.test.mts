import assert from "node:assert";

import { spawn, execFileSync, type ChildProcess } from "node:child_process";

import { createServer, type Server } from "node:http";

import type { AddressInfo } from "node:net";

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";

import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, it } from "node:test";

import {
	fetchAndStoreReport,
	parseAnalyzedAt,
	REPORT_JSON_REL_PATH,
	REPORT_REL_PATH,
	resetReportCache,
	setFetchFactory,
	setWriteFileFactory,
} from "../lib/fetch-report.ts";

interface Shim {
	base: string;
	mdCount(): number;
	jsonCount(): number;
	runPosts(): number;
	statusPolls(): number;
	close(): Promise<void>;
}

interface ShimOpts {
	status?: number;
	/** Per-request md statuses (last repeats); overrides `status`. */
	mdStatuses?: number[];
	body?: string;
	analyzedAt?: string | null;
	jsonStatus?: number;
	jsonBody?: string;
	/** Body served at /api/analysis/bridge-status (404 when omitted). */
	bridgeStatus?: unknown;
	bridgeStatusStatus?: number;
	/** Status for POST /api/analysis/run (404 = run route absent). */
	runStatus?: number;
	runStatusBody?: unknown;
	/** Sequence of /api/analysis/run-status bodies (last repeats). */
	statuses?: unknown[];
	statusStatus?: number;
}

async function startShim(opts: ShimOpts): Promise<Shim> {
	let md = 0;
	let json = 0;
	let runPosts = 0;
	let statusPolls = 0;
	const server: Server = createServer((req, res) => {
		if ((req.url ?? "").endsWith("/api/analysis/run-status")) {
			const body = (opts.statuses ?? [])[Math.min(statusPolls, (opts.statuses ?? []).length - 1)];
			statusPolls++;
			const status = opts.statusStatus ?? 200;
			res.statusCode = status;
			if (status === 200) {
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.end(JSON.stringify(body ?? {}));
			} else {
				res.end("err");
			}
			return;
		}
		if ((req.url ?? "").endsWith("/api/analysis/run")) {
			runPosts++;
			const status = opts.runStatus ?? 404;
			res.statusCode = status;
			if (opts.runStatusBody !== undefined && status !== 404) {
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.end(JSON.stringify(opts.runStatusBody));
			} else {
				res.end("err");
			}
			return;
		}
		if ((req.url ?? "").endsWith("/api/analysis/bridge-status")) {
			const status = opts.bridgeStatusStatus ?? (opts.bridgeStatus === undefined ? 404 : 200);
			res.statusCode = status;
			if (status === 200) {
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.end(JSON.stringify(opts.bridgeStatus ?? {}));
			} else {
				res.end("err");
			}
			return;
		}
		if ((req.url ?? "").endsWith("/api/analysis/report.json")) {
			json++;
			const status = opts.jsonStatus ?? 404;
			res.statusCode = status;
			if (status === 200) {
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.end(opts.jsonBody ?? "{}");
			} else {
				res.end("err");
			}
			return;
		}
		md++;
		const status = opts.mdStatuses
			? opts.mdStatuses[Math.min(md - 1, opts.mdStatuses.length - 1)]
			: (opts.status ?? 200);
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
		mdCount: () => md,
		jsonCount: () => json,
		runPosts: () => runPosts,
		statusPolls: () => statusPolls,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function routeTo(shim: Shim): void {
	setFetchFactory((url, init) => fetch(shim.base + new URL(url).pathname, init));
}

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

async function shim(opts: ShimOpts): Promise<Shim> {
	const s = await startShim(opts);
	shims.push(s);
	return s;
}

const REPORT_PATH = () => join(cwd, REPORT_REL_PATH);

const REPORT_JSON_PATH = () => join(cwd, REPORT_JSON_REL_PATH);

const tmpFiles = () => {
	const dir = join(cwd, "ignore");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".tmp"));
};

const JSON_BODY = '{"architectureIssues":[{"title":"x","affectedFiles":["src/a.ts"]}]}';

const MARKED_JSON_BODY =
	'{"architectureIssues":[{"title":"x","affectedFiles":["src/a.ts"],"description":"# CodeFlow Analysis Report"}]}';

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

const STUB_ANALYZER = `import json, os, sys, time
src, ui, out = sys.argv[1], sys.argv[2], sys.argv[3]
open(os.path.join(out, "report.md"), "w").write(open(os.environ["STUB_MD"]).read())
open(os.path.join(out, "report.json"), "w").write(open(os.environ["STUB_JSON"]).read())
print(json.dumps({"markdown": "report.md", "json": "report.json", "analyzedAt": int(time.time() * 1000)}))
`;

function gitRepoWithCommit(dir: string): void {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
	execFileSync("git", ["init", "-q"], { cwd: dir, env });
	writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
	execFileSync("git", ["add", "app.ts"], { cwd: dir, env });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
}

async function startJourneyShim(
	env: Record<string, string>,
): Promise<{ base: string; proc: ChildProcess; log: () => string }> {
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
	const proc = spawn(PYTHON as string, [serverPath], {
		env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1", PYTHONUNBUFFERED: "1" },
	});
	proc.stdout?.on("data", (d) => (log += d.toString()));
	proc.stderr?.on("data", (d) => (log += d.toString()));
	const base = `http://127.0.0.1:${port}`;
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
	return { base, proc, log: () => log };
}

describe("headless run integration", () => {
	const SUCCEEDED = {
		runId: "r1",
		state: "succeeded",
		startedAt: 1,
		finishedAt: 2,
		reason: null,
		error: null,
		reportAt: 1767225600000,
		produced: { markdown: true, json: true },
	};
	const RUNNING = {
		runId: "r1",
		state: "running",
		startedAt: 1,
		finishedAt: null,
		reason: null,
		error: null,
		reportAt: null,
		produced: { markdown: false, json: false },
	};

	it("triggers a headless run on an empty slot and re-fetches both artifacts", async () => {
		const s = await shim({
			mdStatuses: [404, 200],
			body: "# CodeFlow Analysis Report\n\nHEADLESS\n",
			analyzedAt: "1767225600000",
			jsonStatus: 200,
			jsonBody: JSON_BODY,
			runStatus: 202,
			statuses: [RUNNING, SUCCEEDED],
		});
		routeTo(s);

		const outcome = await fetchAndStoreReport({ cwd });

		assert.strictEqual(outcome.ok, true);
		assert.strictEqual(s.runPosts(), 1, "exactly one run trigger");
		assert.strictEqual(
			readFileSync(REPORT_PATH(), "utf-8"),
			"# CodeFlow Analysis Report\n\nHEADLESS\n",
		);
		assert.strictEqual(readFileSync(REPORT_JSON_PATH(), "utf-8"), JSON_BODY);
		assert.strictEqual(outcome.ok && outcome.result.analyzedAt, 1767225600000);
	});

	it("keeps the actionable 404 when the run route is absent", async () => {
		const s = await shim({ mdStatuses: [404] }); // runStatus defaults to 404
		routeTo(s);

		const outcome = await fetchAndStoreReport({ cwd });

		assert.strictEqual(outcome.ok, false);
		assert.strictEqual(outcome.ok === false ? outcome.status : 0, 404);
		assert.match(outcome.ok === false ? outcome.message : "", /run analysis in CodeFlow/);
		assert.strictEqual(s.runPosts(), 1, "the run route is probed once");
	});

	it("maps a failed run to the run-failure branch, never to the browser 404", async () => {
		const s = await shim({
			mdStatuses: [404],
			runStatus: 202,
			statuses: [{ ...RUNNING, state: "failed", reason: "analyzer-error", error: "boom" }],
		});
		routeTo(s);

		const outcome = await fetchAndStoreReport({ cwd });

		assert.strictEqual(outcome.ok, false);
		if (outcome.ok) return;
		assert.strictEqual(outcome.status, null);
		assert.match(outcome.message, /analyzer-error/);
	});

	it("maps an unavailable analyzer to a null-status failure naming it", async () => {
		const s = await shim({
			mdStatuses: [404],
			runStatus: 503,
			runStatusBody: { reason: "analyzer-unavailable" },
		});
		routeTo(s);

		const outcome = await fetchAndStoreReport({ cwd });

		assert.strictEqual(outcome.ok, false);
		if (outcome.ok) return;
		assert.strictEqual(outcome.status, null);
		assert.match(outcome.message, /unavailable/);
	});

	it("never triggers a run when the report is already present", async () => {
		const s = await shim({ status: 200, body: "MD", jsonStatus: 200, jsonBody: JSON_BODY });
		routeTo(s);

		const outcome = await fetchAndStoreReport({ cwd });

		assert.strictEqual(outcome.ok, true);
		assert.strictEqual(s.runPosts(), 0, "a present report must not trigger a run");
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
		assert.strictEqual(s.mdCount(), 1, "second call must hit the cache");
		assert.strictEqual(s.jsonCount(), 1, "json fetch must also be cached");
		await fetchAndStoreReport({ cwd, refresh: true });
		assert.strictEqual(s.mdCount(), 2, "refresh must bypass the cache");
	});
});
