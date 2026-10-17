import assert from "node:assert";

import { spawn, execFileSync, type ChildProcess } from "node:child_process";

import { createServer, type Server } from "node:http";

import type { AddressInfo } from "node:net";

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
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

describe("partial run disclosure", () => {
	it("re-homes a JSON body misrouted to the markdown route into the JSON artifact", async () => {
		const s = await shim({
			status: 200,
			body: MARKED_JSON_BODY,
			jsonStatus: 404,
			bridgeStatusStatus: 404,
		});
		routeTo(s);
		// A previous buggy run left the misrouted JSON at the markdown path.
		mkdirSync(join(cwd, "ignore"), { recursive: true });
		writeFileSync(REPORT_PATH(), MARKED_JSON_BODY, "utf-8");
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		const { path, jsonPath, partial, recoveredFromMarkdownRoute, warnings } = outcome.result;
		assert.ok(jsonPath !== null, "misrouted JSON must be recovered into the JSON artifact");
		assert.strictEqual(readFileSync(REPORT_JSON_PATH(), "utf-8"), MARKED_JSON_BODY);
		// A recovered JSON body must never be persisted as the markdown artifact,
		// but `path` must still point at a readable markdown file (not a dangling
		// path to a file nobody wrote).
		assert.strictEqual(path, REPORT_PATH());
		assert.ok(existsSync(REPORT_PATH()), "the markdown path must hold a real artifact");
		const markdown = readFileSync(REPORT_PATH(), "utf-8");
		assert.notStrictEqual(markdown, MARKED_JSON_BODY);
		assert.match(markdown, /^# CodeFlow Analysis Report/, "markdown path must hold markdown");
		assert.ok(!markdown.includes("architectureIssues"), "no JSON body at the markdown path");
		assert.match(warnings.join(" "), /placeholder markdown/i);
		assert.strictEqual(partial, false);
		assert.strictEqual(recoveredFromMarkdownRoute, true);
		assert.ok(warnings.join(" ").length > 0, "recovery must be loud, not silent");
	});

	it("keeps the full export recovered from the markdown route when the JSON slot is a stale stub", async () => {
		const fullExport = JSON.stringify({
			summary: { totalFiles: 10 },
			architectureIssues: [{ title: "x", affectedFiles: ["src/a.ts"] }],
			duplicates: [{ files: [{ file: "src/a.ts" }, { file: "src/b.ts" }] }],
		});
		const staleStub = '{"architectureIssues":[]}';
		const s = await shim({ status: 200, body: fullExport, jsonStatus: 200, jsonBody: staleStub });
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		assert.strictEqual(outcome.result.recoveredFromMarkdownRoute, true);
		assert.strictEqual(outcome.result.partial, false);
		assert.strictEqual(readFileSync(REPORT_JSON_PATH(), "utf-8"), fullExport);
		const warnings = outcome.result.warnings.join(" ");
		assert.match(warnings, /smaller export/i);
		assert.match(warnings, /recovered body was kept/i);
	});

	it("prefers the JSON route body when it is at least as large as the recovered body", async () => {
		const recovered = '{"architectureIssues":[{"title":"old"}]}';
		const routeBody = '{"architectureIssues":[{"title":"new","affectedFiles":["src/b.ts"]}]}';
		const s = await shim({ status: 200, body: recovered, jsonStatus: 200, jsonBody: routeBody });
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		assert.strictEqual(readFileSync(REPORT_JSON_PATH(), "utf-8"), routeBody);
		assert.ok(!/smaller export/i.test(outcome.result.warnings.join(" ")));
	});

	it("removes a stale JSON artifact so a partial refresh cannot look complete", async () => {
		const s = await shim({ status: 200, body: "MD", jsonStatus: 404, bridgeStatusStatus: 404 });
		routeTo(s);
		// An earlier analysis left a structured artifact behind; `dry-run.mts`
		// auto-loads this path, so a JSON-less refresh must not leave it in place.
		mkdirSync(join(cwd, "ignore"), { recursive: true });
		writeFileSync(REPORT_JSON_PATH(), '{"architectureIssues":[{"title":"stale"}]}', "utf-8");

		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		assert.strictEqual(outcome.result.jsonPath, null);
		assert.strictEqual(outcome.result.partial, true);
		assert.ok(
			!existsSync(REPORT_JSON_PATH()),
			"stale JSON artifact must not survive a JSON-less fetch",
		);
		assert.match(outcome.result.warnings.join(" "), /stale structured JSON artifact/i);
	});

	it("marks a run with genuinely absent JSON partial and names the blind categories", async () => {
		const s = await shim({ status: 200, body: "MD", jsonStatus: 404, bridgeStatusStatus: 404 });
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		assert.strictEqual(outcome.result.jsonPath, null);
		assert.strictEqual(outcome.result.partial, true);
		assert.deepStrictEqual(outcome.result.unavailableCategories, [
			"duplicate",
			"layer-violation",
			"suggestion",
		]);
		assert.ok(outcome.result.warnings.join(" ").length > 0);
		assert.ok(existsSync(REPORT_PATH()), "the markdown artifact is still written");
		assert.ok(!existsSync(REPORT_JSON_PATH()));
	});

	it("is complete when both routes serve their format", async () => {
		const s = await shim({
			status: 200,
			body: "# CodeFlow Analysis Report\n",
			jsonStatus: 200,
			jsonBody: JSON_BODY,
		});
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		assert.strictEqual(outcome.result.partial, false);
		assert.deepStrictEqual(outcome.result.unavailableCategories, []);
		assert.ok(!outcome.result.recoveredFromMarkdownRoute);
	});

	it("does not store a markdown body served on the JSON route", async () => {
		const s = await shim({
			status: 200,
			body: "MD",
			jsonStatus: 200,
			jsonBody: "# CodeFlow Analysis Report\n",
		});
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		assert.strictEqual(outcome.result.jsonPath, null);
		assert.strictEqual(outcome.result.partial, true);
		assert.ok(!existsSync(REPORT_JSON_PATH()));
	});

	it("does not store a body that is neither JSON-with-architectureIssues nor markdown", async () => {
		const s = await shim({ status: 200, body: "MD", jsonStatus: 200, jsonBody: '{"files":[]}' });
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		assert.strictEqual(outcome.result.jsonPath, null);
		assert.strictEqual(outcome.result.partial, true);
		assert.ok(!existsSync(REPORT_JSON_PATH()));
	});

	it("treats a facts-less stub JSON body as no structured export (partial, categories named)", async () => {
		const stub = '{"architectureIssues":[]}';
		const s = await shim({
			status: 200,
			body: "# CodeFlow Analysis Report\n",
			jsonStatus: 200,
			jsonBody: stub,
		});
		routeTo(s);
		// A previous analysis left a structured artifact behind; the stub must not
		// let it (or the stub) masquerade as this run's complete JSON.
		mkdirSync(join(cwd, "ignore"), { recursive: true });
		writeFileSync(REPORT_JSON_PATH(), '{"architectureIssues":[{"title":"stale"}]}', "utf-8");

		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		assert.strictEqual(outcome.result.jsonPath, null);
		assert.strictEqual(outcome.result.partial, true);
		assert.deepStrictEqual(outcome.result.unavailableCategories, [
			"duplicate",
			"layer-violation",
			"suggestion",
		]);
		assert.match(outcome.result.warnings.join(" "), /stub|no findings|yields no facts/i);
		assert.ok(!existsSync(REPORT_JSON_PATH()), "a stale JSON artifact must be removed");
		assert.ok(existsSync(REPORT_PATH()), "the markdown artifact is still written");
	});

	it("does not write a JSON artifact when the JSON route serves only a stub", async () => {
		const s = await shim({
			status: 200,
			body: "MD",
			jsonStatus: 200,
			jsonBody: '{"architectureIssues":[]}',
		});
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		assert.ok(!existsSync(REPORT_JSON_PATH()), "a stub must never be stored as JSON");
	});

	it("treats a stub JSON body on the markdown route as a misroute, not a recovery", async () => {
		const stub = '{"architectureIssues":[]}';
		const s = await shim({ status: 200, body: stub, jsonStatus: 404, bridgeStatusStatus: 404 });
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		assert.strictEqual(outcome.result.partial, true);
		assert.strictEqual(outcome.result.jsonPath, null);
		assert.strictEqual(outcome.result.recoveredFromMarkdownRoute, false);
		const markdown = readFileSync(REPORT_PATH(), "utf-8");
		assert.match(markdown, /^# CodeFlow Analysis Report/);
		assert.ok(
			!markdown.includes("architectureIssues"),
			"JSON bytes must never sit at the markdown path",
		);
		assert.match(outcome.result.warnings.join(" "), /markdown route returned a JSON body|stub/i);
	});

	it("keeps a usable JSON route export when the markdown route served a stub", async () => {
		const stub = '{"architectureIssues":[]}';
		const s = await shim({ status: 200, body: stub, jsonStatus: 200, jsonBody: JSON_BODY });
		routeTo(s);
		const outcome = await fetchAndStoreReport({ cwd });
		assert.strictEqual(outcome.ok, true);
		if (!outcome.ok) return;
		assert.strictEqual(outcome.result.partial, false);
		assert.strictEqual(outcome.result.recoveredFromMarkdownRoute, false);
		assert.strictEqual(readFileSync(REPORT_JSON_PATH(), "utf-8"), JSON_BODY);
		const markdown = readFileSync(REPORT_PATH(), "utf-8");
		assert.match(markdown, /^# CodeFlow Analysis Report/);
		assert.ok(!markdown.includes("architectureIssues"), "no JSON body at the markdown path");
	});
});
