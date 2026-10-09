/**
 * Tests for .pi/skills/audit-codeflow-analysis/lib/fetch-report.ts — HTTP
 * transport and the `ignore/codeflow-report.{md,json}` artifacts.
 *
 * A real `node:http` shim stands in for the codeflow container; the fetch
 * factory is pointed at it so request counting and status handling are
 * exercised end to end. No Docker and no live CodeFlow.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/codeflow-analysis.test.mts
 */

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
	classifyReportBody,
	fetchAndStoreReport,
	parseAnalyzedAt,
	REPORT_JSON_REL_PATH,
	REPORT_REL_PATH,
	resetReportCache,
	setFetchFactory,
	setWriteFileFactory,
} from "../lib/fetch-report.ts";
import { groupIssues, parseBestReport, parseReport } from "../lib/report.ts";
import { runFetchReportCli } from "../scripts/fetch-report.mts";

// ── Mock shim ───────────────────────────────────

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

/** Point the extension's fetch factory at a mock base, preserving the path. */
function routeTo(shim: Shim): void {
	setFetchFactory((url, init) => fetch(shim.base + new URL(url).pathname, init));
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
// A JSON export that embeds the markdown marker in a source snippet — the body
// a pre-#1976 bridge misroutes to the markdown route.
const MARKED_JSON_BODY =
	'{"architectureIssues":[{"title":"x","affectedFiles":["src/a.ts"],"description":"# CodeFlow Analysis Report"}]}';

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

describe("classifyReportBody", () => {
	it("classifies by structure, never by substring", () => {
		assert.strictEqual(classifyReportBody('{"architectureIssues":[]}'), "json");
		assert.strictEqual(classifyReportBody("# CodeFlow Analysis Report\n"), "markdown");
		assert.strictEqual(classifyReportBody('{"files":[]}'), "other");
		assert.strictEqual(classifyReportBody("[]"), "other");
		assert.strictEqual(classifyReportBody("x"), "other");
		assert.strictEqual(classifyReportBody(""), "other");
		assert.strictEqual(classifyReportBody('{"architectureIssues":"nope"}'), "other");
		// A JSON object without architectureIssues but carrying the marker is markdown.
		assert.strictEqual(classifyReportBody('{"note":"# CodeFlow Analysis Report"}'), "markdown");
	});
});

describe("partial run disclosure", () => {
	it("re-homes a JSON body misrouted to the markdown route into the JSON artifact", async () => {
		const s = await shim({ status: 200, body: MARKED_JSON_BODY, jsonStatus: 404, bridgeStatusStatus: 404 });
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
		assert.ok(!existsSync(REPORT_JSON_PATH()), "stale JSON artifact must not survive a JSON-less fetch");
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
});

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
		assert.strictEqual(readFileSync(REPORT_PATH(), "utf-8"), "# CodeFlow Analysis Report\n\nHEADLESS\n");
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
		const s = await shim({ mdStatuses: [404], runStatus: 503, runStatusBody: { reason: "analyzer-unavailable" } });
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
		routeTo({ base, mdCount: () => 0, jsonCount: () => 0, runPosts: () => 0, statusPolls: () => 0, close: async () => {} });

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

// ── Phase 6: operator recovers from an empty slot unattended ──

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
		routeTo({ base: journey.base, mdCount: () => 0, jsonCount: () => 0, runPosts: () => 0, statusPolls: () => 0, close: async () => {} });

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
		routeTo({ base: journey.base, mdCount: () => 0, jsonCount: () => 0, runPosts: () => 0, statusPolls: () => 0, close: async () => {} });

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
