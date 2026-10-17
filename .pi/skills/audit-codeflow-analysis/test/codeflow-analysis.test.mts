import assert from "node:assert";

import { spawn, execFileSync, type ChildProcess } from "node:child_process";

import { createServer, type Server } from "node:http";

import type { AddressInfo } from "node:net";

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";

import { join, resolve } from "node:path";

import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, it } from "node:test";

import {
	fetchAndStoreReport,
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

describe("transport + artifact", () => {
	it("writes both artifacts and returns path/jsonPath/bytes/analyzedAt", async () => {
		const body = "# CodeFlow Analysis Report\n\n## Architecture Issues\n";
		const s = await shim({
			status: 200,
			body,
			analyzedAt: "1767225600000",
			jsonStatus: 200,
			jsonBody: JSON_BODY,
		});
		routeTo(s);

		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		const { path, jsonPath, bytes, analyzedAt } = outcome.result;

		const target = REPORT_PATH();
		const jsonTarget = REPORT_JSON_PATH();
		assert.ok(existsSync(target), "report file should exist");
		assert.ok(existsSync(jsonTarget), "json report file should exist");
		assert.strictEqual(readFileSync(target, "utf-8"), body);
		assert.strictEqual(readFileSync(jsonTarget, "utf-8"), JSON_BODY);
		assert.strictEqual(path, target);
		assert.strictEqual(jsonPath, jsonTarget);
		assert.strictEqual(bytes, Buffer.byteLength(body));
		assert.strictEqual(analyzedAt, 1767225600000);
		assert.ok(path.startsWith(cwd), "path must resolve inside cwd");
		assert.ok(jsonPath !== null && jsonPath.startsWith(cwd), "jsonPath must resolve inside cwd");
	});
	it("writes the artifacts with mode 0600", async (t) => {
		if (process.platform === "win32") return t.skip("POSIX file modes not available on Windows");
		const s = await shim({ status: 200, body: "MD", jsonStatus: 200, jsonBody: JSON_BODY });
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd, refresh: true });
		assert.strictEqual(outcome.ok, true);
		assert.strictEqual(
			statSync(REPORT_PATH()).mode & 0o777,
			0o600,
			"markdown artifact must be 0600",
		);
		assert.strictEqual(
			statSync(REPORT_JSON_PATH()).mode & 0o777,
			0o600,
			"json artifact must be 0600",
		);
	});
	it("still succeeds without JSON (404) and names the capture gap via bridge-status", async () => {
		const s = await shim({
			status: 200,
			body: "MD",
			jsonStatus: 404,
			bridgeStatus: {
				"/api/analysis/report.json": {
					capturedAt: null,
					postedAt: null,
					httpStatus: null,
					bytes: null,
				},
			},
		});
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		assert.strictEqual(outcome.ok && outcome.result.jsonPath, null);
		assert.strictEqual(outcome.ok && outcome.result.partial, true);
		assert.match(outcome.ok ? outcome.result.warnings.join(" ") : "", /never POSTed/);
		assert.ok(existsSync(REPORT_PATH()));
		assert.ok(!existsSync(REPORT_JSON_PATH()));
	});
	it("names the shim route as down when the bridge posted JSON but GET 404s", async () => {
		const s = await shim({
			status: 200,
			body: "MD",
			jsonStatus: 404,
			bridgeStatus: {
				"/api/analysis/report.json": { capturedAt: 1, postedAt: 2, httpStatus: 200, bytes: 10 },
			},
		});
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		assert.match(outcome.ok ? outcome.result.warnings.join(" ") : "", /route is down/);
	});
	it("honors abort during the bridge-status probe after a JSON 404", async () => {
		let statusProbeStarted: () => void = () => {};
		const started = new Promise<void>((resolveStarted) => (statusProbeStarted = resolveStarted));
		setFetchFactory((url, init) => {
			const path = new URL(url).pathname;
			if (path.endsWith("/api/analysis/report.json")) {
				return Promise.resolve(new Response("nope", { status: 404 }));
			}
			if (path.endsWith("/api/analysis/bridge-status")) {
				statusProbeStarted();
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				});
			}
			return Promise.resolve(new Response("MD", { status: 200 }));
		});

		const controller = new AbortController();
		const promise = fetchAndStoreReport({ cwd, signal: controller.signal });
		await started;
		controller.abort();
		await assert.rejects(() => promise, "abort must not be swallowed as a successful result");
	});
	it("falls back to a generic warning when bridge-status is unavailable", async () => {
		const s = await shim({ status: 200, body: "MD", jsonStatus: 404, bridgeStatusStatus: 404 });
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		assert.match(
			outcome.ok ? outcome.result.warnings.join(" ") : "",
			/bridge-status is unreachable/,
		);
	});
	it("surfaces a non-404 JSON failure as a warning but keeps the markdown report", async () => {
		const s = await shim({ status: 200, body: "MD", jsonStatus: 500 });
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		assert.strictEqual(outcome.ok && outcome.result.jsonPath, null);
		assert.match(outcome.ok ? outcome.result.warnings.join(" ") : "", /HTTP 500/);
		assert.ok(existsSync(REPORT_PATH()));
	});
	it("returns an actionable error and leaves a pre-existing report intact on 404", async () => {
		const s = await shim({ status: 404 });
		routeTo(s);
		const target = REPORT_PATH();
		mkdirSync(join(cwd, "ignore"), { recursive: true });
		writeFileSync(target, "PRE-EXISTING");

		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, false);
		assert.match(outcome.ok === false ? outcome.message : "", /run analysis in CodeFlow/);
		assert.strictEqual(outcome.ok === false ? outcome.status : 0, 404);
		assert.strictEqual(readFileSync(target, "utf-8"), "PRE-EXISTING");
	});
	it("surfaces a 500 and writes no file", async () => {
		const s = await shim({ status: 500 });
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, false);
		assert.match(outcome.ok === false ? outcome.message : "", /HTTP 500/);
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
	it("refuses to write when ignore/ is a symlink escaping the workspace", async (t) => {
		const s = await shim({ status: 200, body: "EVIL" });
		routeTo(s);
		const outside = mkdtempSync(join(tmpdir(), "codeflow-outside-"));
		try {
			symlinkSync(outside, join(cwd, "ignore"), "dir");
		} catch {
			return t.skip("symlinks not supported on this platform");
		}
		await assert.rejects(() => fetchAndStoreReport({ cwd, refresh: true }), /symlink escape/);
		assert.ok(
			!existsSync(join(outside, "codeflow-report.md")),
			"must not write through the symlinked ignore directory",
		);
	});
	it("replaces a symlinked report path instead of following it", async (t) => {
		const s = await shim({ status: 200, body: "SAFE" });
		routeTo(s);
		const outside = mkdtempSync(join(tmpdir(), "codeflow-target-"));
		const victim = join(outside, "victim.txt");
		writeFileSync(victim, "UNTOUCHED");
		mkdirSync(join(cwd, "ignore"), { recursive: true });
		try {
			symlinkSync(victim, REPORT_PATH(), "file");
		} catch {
			return t.skip("symlinks not supported on this platform");
		}
		const outcome = await fetchAndStoreReport({ cwd, refresh: true });
		assert.strictEqual(outcome.ok, true);
		assert.strictEqual(readFileSync(victim, "utf-8"), "UNTOUCHED");
		assert.ok(
			!lstatSync(REPORT_PATH()).isSymbolicLink(),
			"symlink must be replaced by a regular file",
		);
		assert.strictEqual(readFileSync(REPORT_PATH(), "utf-8"), "SAFE");
	});
});
describe("transport + artifact", () => {
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
