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
	REPORT_JSON_REL_PATH,
	REPORT_REL_PATH,
	resetReportCache,
	setFetchFactory,
	setWriteFileFactory,
} from "../lib/fetch-report.ts";

import { groupIssues, parseBestReport, parseReport } from "../lib/report.ts";

import { runFetchReportCli } from "../scripts/fetch-report.mts";

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

describe("e2e: real codeflow shim subprocess", () => {
	it("404s before analysis, then round-trips both fixtures into a grouped plan", async (t) => {
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
		routeTo({
			base,
			mdCount: () => 0,
			jsonCount: () => 0,
			runPosts: () => 0,
			statusPolls: () => 0,
			close: async () => {},
		});

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

		const fixtureDir = join(import.meta.dirname, "fixtures");
		const mdFixture = readFileSync(join(fixtureDir, "codeflow-report.md"), "utf-8");
		const jsonFixture = readFileSync(join(fixtureDir, "codeflow-report.json"), "utf-8");

		try {
			// Before the browser bridge POSTs, the tool must report the actionable 404.
			// `runOnMissing:false` isolates this bridge round-trip from the headless
			// run route (whose unattended journey is covered separately below).
			const miss = await fetchAndStoreReport({ cwd, refresh: true, runOnMissing: false });
			assert.strictEqual(miss.ok, false);
			assert.match(miss.ok === false ? miss.message : "", /run analysis in CodeFlow/);

			// Simulate the browser bridge: POST both captured fixtures.
			const postedMd = await fetch(base + "/api/analysis/report", {
				method: "POST",
				headers: { "Content-Type": "text/plain; charset=utf-8" },
				body: mdFixture,
			});
			assert.strictEqual(postedMd.status, 204);
			const postedJson = await fetch(base + "/api/analysis/report.json", {
				method: "POST",
				headers: { "Content-Type": "text/plain; charset=utf-8" },
				body: jsonFixture,
			});
			assert.strictEqual(postedJson.status, 204);

			// Bridge telemetry reflects what the browser shipped, per route.
			const bridgeStatus = await (await fetch(base + "/api/analysis/bridge-status")).json();
			assert.ok(bridgeStatus["/api/analysis/report"].postedAt, "markdown postedAt must be set");
			assert.strictEqual(bridgeStatus["/api/analysis/report.json"].httpStatus, 204);
			assert.strictEqual(
				bridgeStatus["/api/analysis/report.json"].bytes,
				Buffer.byteLength(jsonFixture),
			);

			const outcome = await fetchAndStoreReport({ cwd, refresh: true });
			assert.strictEqual(outcome.ok, true);
			assert.strictEqual(readFileSync(REPORT_PATH(), "utf-8"), mdFixture);
			assert.strictEqual(readFileSync(REPORT_JSON_PATH(), "utf-8"), jsonFixture);

			// Grouping over the richer JSON source yields the JSON-only categories.
			const facts = parseBestReport(mdFixture, jsonFixture);
			assert.ok(
				facts.some((f) => f.kind === "duplicate"),
				"JSON source must expose duplicates",
			);
			const groups = groupIssues(facts);
			assert.ok(groups.length >= 1, "fixture must yield at least one group");
			const groupFiles = groups.map((g) => new Set(g.issues.flatMap((i) => i.files)));
			for (let a = 0; a < groupFiles.length; a++) {
				for (let b = a + 1; b < groupFiles.length; b++) {
					for (const f of groupFiles[a]) {
						assert.ok(!groupFiles[b].has(f), `file ${f} shared across two groups`);
					}
				}
			}
			// Markdown alone still parses (fallback path).
			assert.ok(parseReport(mdFixture).length > 0);
		} finally {
			proc.kill("SIGKILL");
			await waitForExit(proc);
			assert.ok(!log.includes("Traceback"), `shim logged a traceback:\n${log}`);
		}
	});
});
describe("e2e: unattended recovery from an empty report slot", () => {
	it("auto-runs the headless analyzer and the fetch CLI exits 0 with both artifacts", async (t) => {
		if (!PYTHON) return t.skip("python3 not available");

		const repo = mkdtempSync(join(tmpdir(), "codeflow-journey-repo-"));
		gitRepoWithCommit(repo);
		const stubDir = mkdtempSync(join(tmpdir(), "codeflow-journey-stub-"));
		const stub = join(stubDir, "stub.py");
		writeFileSync(stub, STUB_ANALYZER);
		const fixtureDir = join(import.meta.dirname, "fixtures");

		const journey = await startJourneyShim({
			REPO_ROOT: repo,
			UI_DIR: stubDir,
			CONFIG_FILE: join(stubDir, "missing.json"),
			ANALYZER_CMD: `python3 ${stub}`,
			STUB_MD: join(fixtureDir, "codeflow-report.md"),
			STUB_JSON: join(fixtureDir, "codeflow-report.json"),
		});
		routeTo({
			base: journey.base,
			mdCount: () => 0,
			jsonCount: () => 0,
			runPosts: () => 0,
			statusPolls: () => 0,
			close: async () => {},
		});

		let out = "";
		let err = "";
		const io = { stdout: (s: string) => (out += s), stderr: (s: string) => (err += s) };
		try {
			const code = await runFetchReportCli([], io, cwd);
			assert.strictEqual(code, 0, `stderr: ${err}`);
			assert.ok(existsSync(REPORT_PATH()), "markdown artifact must be written");
			assert.ok(existsSync(REPORT_JSON_PATH()), "json artifact must be written");
			const md = readFileSync(REPORT_PATH(), "utf-8");
			const json = readFileSync(REPORT_JSON_PATH(), "utf-8");
			assert.ok(parseBestReport(md, json).length > 0, "artifacts must parse");
		} finally {
			journey.proc.kill("SIGKILL");
			await waitForExit(journey.proc);
			assert.ok(!journey.log().includes("Traceback"), `shim logged a traceback:\n${journey.log()}`);
		}
	});

	it("exits 1 naming the analyzer when the image carries none (503)", async (t) => {
		if (!PYTHON) return t.skip("python3 not available");

		const repo = mkdtempSync(join(tmpdir(), "codeflow-journey-repo-"));
		gitRepoWithCommit(repo);
		const dir = mkdtempSync(join(tmpdir(), "codeflow-journey-stub-"));
		const journey = await startJourneyShim({
			REPO_ROOT: repo,
			UI_DIR: dir,
			CONFIG_FILE: join(dir, "missing.json"),
			ANALYZER_CMD: `python3 ${join(dir, "absent.py")}`,
		});
		routeTo({
			base: journey.base,
			mdCount: () => 0,
			jsonCount: () => 0,
			runPosts: () => 0,
			statusPolls: () => 0,
			close: async () => {},
		});

		let out = "";
		let err = "";
		const io = { stdout: (s: string) => (out += s), stderr: (s: string) => (err += s) };
		try {
			const code = await runFetchReportCli([], io, cwd);
			assert.strictEqual(code, 1);
			assert.match(err, /unavailable/);
			assert.strictEqual(out, "");
			assert.ok(!existsSync(REPORT_PATH()), "no artifact when the analyzer is unavailable");
		} finally {
			journey.proc.kill("SIGKILL");
			await waitForExit(journey.proc);
			assert.ok(!journey.log().includes("Traceback"), `shim logged a traceback:\n${journey.log()}`);
		}
	});
});
