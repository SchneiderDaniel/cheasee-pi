/**
 * Tests for .pi/skills/audit-codeflow-analysis/scripts/fetch-report.mts — the
 * CLI adapter over `lib/fetch-report.ts`.
 *
 * The adapter is imported in-process (`runFetchReportCli` never calls
 * `process.exit`) and driven through the use-case's transport/write seams, so
 * argv parsing and exit-code mapping are verified without spawning node.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/fetch-report-cli.test.mts
 */

import assert from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetReportCache, setFetchFactory, setWriteFileFactory } from "../lib/fetch-report.ts";
import { runFetchReportCli, type CliIo } from "../scripts/fetch-report.mts";

// ── Capturing IO ────────────────────────────────

interface Capture {
	io: CliIo;
	out(): string;
	err(): string;
}

function capture(): Capture {
	let out = "";
	let err = "";
	return {
		io: { stdout: (t) => (out += t), stderr: (t) => (err += t) },
		out: () => out,
		err: () => err,
	};
}

// ── Mock shim ───────────────────────────────────

interface Shim {
	base: string;
	mdCount(): number;
	runPosts(): number;
	close(): Promise<void>;
}

interface ShimRun {
	/** Status for POST /api/analysis/run (404 = run route absent). */
	runStatus?: number;
	runBody?: unknown;
	/** Per-request md statuses (last repeats); overrides `status`. */
	mdStatuses?: number[];
	/** /api/analysis/run-status bodies (last repeats). */
	statuses?: unknown[];
	analyzedAt?: string;
}

async function startShim(status: number, body: string, run?: ShimRun): Promise<Shim> {
	let md = 0;
	let runPosts = 0;
	let polls = 0;
	const server: Server = createServer((req, res) => {
		const url = req.url ?? "";
		if (url.endsWith("/api/analysis/run-status")) {
			const statuses = run?.statuses ?? [];
			res.statusCode = 200;
			res.setHeader("Content-Type", "application/json; charset=utf-8");
			res.end(JSON.stringify(statuses[Math.min(polls++, statuses.length - 1)] ?? {}));
			return;
		}
		if (url.endsWith("/api/analysis/run")) {
			runPosts++;
			const runStatus = run?.runStatus ?? 404;
			res.statusCode = runStatus;
			if (runStatus === 404) {
				res.end("err");
			} else {
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.end(JSON.stringify(run?.runBody ?? {}));
			}
			return;
		}
		if (url.endsWith("/api/analysis/bridge-status")) {
			res.statusCode = 404;
			res.end();
			return;
		}
		if (url.endsWith("/report.json")) {
			res.statusCode = 404;
			res.end();
			return;
		}
		md++;
		const mdStatus = run?.mdStatuses
			? run.mdStatuses[Math.min(md - 1, run.mdStatuses.length - 1)]
			: status;
		res.statusCode = mdStatus;
		if (mdStatus === 200) {
			res.setHeader("Content-Type", "text/markdown; charset=utf-8");
			res.setHeader("X-Codeflow-Analysis-At", run?.analyzedAt ?? "1767225600000");
			res.end(body);
		} else {
			res.end("err");
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const port = (server.address() as AddressInfo).port;
	return {
		base: `http://127.0.0.1:${port}`,
		mdCount: () => md,
		runPosts: () => runPosts,
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}

function routeTo(shim: Shim): void {
	setFetchFactory((url, init) => fetch(shim.base + new URL(url).pathname, init));
}

let cwd: string;
let shims: Shim[] = [];

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "codeflow-cli-"));
	resetReportCache();
});

afterEach(async () => {
	setFetchFactory();
	setWriteFileFactory();
	resetReportCache();
	await Promise.all(shims.map((s) => s.close()));
	shims = [];
});

async function shim(status: number, body = "MD", run?: ShimRun): Promise<Shim> {
	const s = await startShim(status, body, run);
	shims.push(s);
	return s;
}

const REPORT_PATH = () => join(cwd, "ignore/codeflow-report.md");

describe("fetch-report CLI adapter", () => {
	it("prints pure JSON and exits 0 on success", async () => {
		const s = await shim(200, "# CodeFlow Analysis Report\n");
		routeTo(s);
		const cap = capture();

		const code = await runFetchReportCli([], cap.io, cwd);

		assert.strictEqual(code, 0);
		const parsed = JSON.parse(cap.out());
		assert.strictEqual(parsed.bytes, Buffer.byteLength("# CodeFlow Analysis Report\n"));
		assert.strictEqual(parsed.analyzedAt, 1767225600000);
		assert.strictEqual(parsed.jsonPath, null);
		assert.strictEqual(parsed.partial, true);
		assert.deepStrictEqual(parsed.unavailableCategories, [
			"duplicate",
			"layer-violation",
			"suggestion",
		]);
		assert.ok(parsed.path.endsWith("ignore/codeflow-report.md"), `unexpected path ${parsed.path}`);
		assert.ok(existsSync(REPORT_PATH()));
		assert.strictEqual(cap.err(), "");
	});

	it("exits 2 with the run-analysis message on a 404 and writes no artifact", async () => {
		const s = await shim(404);
		routeTo(s);
		const cap = capture();

		const code = await runFetchReportCli([], cap.io, cwd);

		assert.strictEqual(code, 2);
		assert.match(cap.err(), /run analysis in CodeFlow/);
		assert.strictEqual(cap.out(), "");
		assert.ok(!existsSync(REPORT_PATH()));
	});

	it("completes the fetch (exit 0) when the headless run fills the empty slot", async () => {
		const s = await shim(404, "# CodeFlow Analysis Report\n", {
			mdStatuses: [404, 200],
			runStatus: 202,
			statuses: [
				{ state: "running", produced: { markdown: false, json: false } },
				{ state: "succeeded", produced: { markdown: true, json: true }, reportAt: 1767225600000 },
			],
		});
		routeTo(s);
		const cap = capture();

		const code = await runFetchReportCli([], cap.io, cwd);

		assert.strictEqual(code, 0, cap.err());
		assert.ok(existsSync(REPORT_PATH()), "the headless run's artifact must be written");
		assert.strictEqual(s.runPosts(), 1, "exactly one run trigger");
	});

	it("exits 1 naming the reason when the headless run fails", async () => {
		const s = await shim(404, "MD", {
			mdStatuses: [404],
			runStatus: 202,
			statuses: [{ state: "failed", reason: "analyzer-error", error: "boom", produced: { markdown: false, json: false } }],
		});
		routeTo(s);
		const cap = capture();

		const code = await runFetchReportCli([], cap.io, cwd);

		assert.strictEqual(code, 1);
		assert.match(cap.err(), /analyzer-error/);
		assert.strictEqual(cap.out(), "");
		assert.ok(!existsSync(REPORT_PATH()));
	});

	it("still completes (exit 0) when a run is already in flight (409)", async () => {
		const s = await shim(404, "# CodeFlow Analysis Report\n", {
			mdStatuses: [404, 200],
			runStatus: 409,
			statuses: [
				{ state: "running", produced: { markdown: false, json: false } },
				{ state: "succeeded", produced: { markdown: true, json: false }, reportAt: 1767225600000 },
			],
		});
		routeTo(s);
		const cap = capture();

		const code = await runFetchReportCli([], cap.io, cwd);

		assert.strictEqual(code, 0, cap.err());
		assert.strictEqual(s.runPosts(), 1, "a 409 must not trigger a second POST");
	});

	it("exits 1 on a transport failure", async () => {
		setFetchFactory((url, init) => fetch("http://127.0.0.1:1" + new URL(url).pathname, init));
		const cap = capture();

		const code = await runFetchReportCli([], cap.io, cwd);

		assert.strictEqual(code, 1);
		assert.match(cap.err(), /CodeFlow request failed/);
		assert.strictEqual(cap.out(), "");
	});

	it("exits 1 when the write fails", async () => {
		const s = await shim(200);
		routeTo(s);
		mkdirSync(join(cwd, "ignore"), { recursive: true });
		setWriteFileFactory(() => {
			throw new Error("disk full");
		});
		const cap = capture();

		const code = await runFetchReportCli([], cap.io, cwd);

		assert.strictEqual(code, 1);
		assert.match(cap.err(), /disk full/);
		assert.strictEqual(cap.out(), "");
	});

	it("uses the cache on a repeat call and bypasses it with --refresh", async () => {
		const s = await shim(200);
		routeTo(s);

		assert.strictEqual(await runFetchReportCli([], capture().io, cwd), 0);
		assert.strictEqual(await runFetchReportCli([], capture().io, cwd), 0);
		assert.strictEqual(s.mdCount(), 1, "second call must hit the cache");

		assert.strictEqual(await runFetchReportCli(["--refresh"], capture().io, cwd), 0);
		assert.strictEqual(s.mdCount(), 2, "--refresh must bypass the cache");
	});

	it("exits 2 on an unknown argument", async () => {
		const cap = capture();
		assert.strictEqual(await runFetchReportCli(["--nope"], cap.io, cwd), 2);
		assert.match(cap.err(), /unknown argument/);
	});

	it("recovers a JSON body misrouted to the markdown route", async () => {
		const marked =
			'{"architectureIssues":[{"title":"x","description":"# CodeFlow Analysis Report"}]}';
		setFetchFactory((url) => {
			const path = new URL(url).pathname;
			if (path.endsWith("/api/analysis/report.json")) {
				return Promise.resolve(new Response("", { status: 404 }));
			}
			return Promise.resolve(
				new Response(marked, {
					status: 200,
					headers: { "X-Codeflow-Analysis-At": "1767225600000" },
				}),
			);
		});
		const cap = capture();

		const code = await runFetchReportCli([], cap.io, cwd);

		assert.strictEqual(code, 0);
		const parsed = JSON.parse(cap.out());
		assert.ok(parsed.jsonPath !== null, "misrouted JSON must be recovered");
		assert.strictEqual(parsed.partial, false);
		assert.strictEqual(parsed.recoveredFromMarkdownRoute, true);
		// `path` must point at a real markdown artifact, not a dangling path.
		assert.ok(parsed.path.endsWith("ignore/codeflow-report.md"), `unexpected path ${parsed.path}`);
		assert.ok(existsSync(REPORT_PATH()), "markdown path must hold a real artifact");
		assert.match(readFileSync(REPORT_PATH(), "utf-8"), /^# CodeFlow Analysis Report/);
	});
});

describe("fetch-report CLI wiring", () => {
	it("delegates endpoint and containment to the shared libs (no inline host/port or path logic)", () => {
		const lib = readFileSync(resolve(import.meta.dirname, "../lib/fetch-report.ts"), "utf-8");
		assert.ok(
			lib.includes('from "../../../extensions/lib/codeflow-endpoint.ts"'),
			"must import the shared endpoint lib",
		);
		assert.ok(lib.includes("codeflowServiceUrl"), "must use codeflowServiceUrl");
		assert.ok(
			lib.includes('from "../../../extensions/lib/path-containment.ts"'),
			"must import the shared containment lib",
		);
		assert.ok(
			lib.includes("resolveWithinRoot") && lib.includes("isPathWithinBase"),
			"must use the containment helpers",
		);

		const cli = readFileSync(resolve(import.meta.dirname, "../scripts/fetch-report.mts"), "utf-8");
		assert.ok(
			!/resolveWithinRoot|isPathWithinBase|CODEFLOW_SERVICE_HOST|8470/.test(cli),
			"the CLI must not inline endpoint/containment logic",
		);
	});
});
