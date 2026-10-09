/**
 * Tests for .pi/skills/audit-codeflow-analysis/lib/codeflow-run.ts — the
 * headless-run use case.
 *
 * The HTTP client, clock and sleep timer are injected, so trigger/poll/timeout
 * policy is exercised deterministically with no real timers or sockets.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/skills/audit-codeflow-analysis/test/codeflow-run.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { ensureReport, parseRunStatus, type RunFetchFn, type SleepFn } from "../lib/codeflow-run.ts";

const BASE = "http://shim";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function statusBody(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		runId: "r1",
		state: "running",
		startedAt: 1,
		finishedAt: null,
		reason: null,
		error: null,
		reportAt: null,
		produced: { markdown: false, json: false },
		...over,
	};
}

interface Harness {
	fetchFn: RunFetchFn;
	sleepFn: SleepFn;
	nowFn: () => number;
	statusPolls: () => number;
	postCount: () => number;
}

function harness(route: (path: string, init: RequestInit | undefined) => Response): Harness {
	let clock = 0;
	let statusPolls = 0;
	let posts = 0;
	const fetchFn: RunFetchFn = async (url, init) => {
		const path = new URL(url).pathname;
		if (path.endsWith("/api/analysis/run")) posts++;
		if (path.endsWith("/api/analysis/run-status")) statusPolls++;
		return route(path, init);
	};
	return {
		fetchFn,
		sleepFn: async (ms) => {
			clock += ms;
		},
		nowFn: () => clock,
		statusPolls: () => statusPolls,
		postCount: () => posts,
	};
}

describe("ensureReport", () => {
	it("triggers once and polls to success, surfacing reportAt", async () => {
		let polls = 0;
		const h = harness((path, init) => {
			if (init?.method === "POST") {
				return json({ runId: "r1", state: "running", startedAt: 1 }, 202);
			}
			polls++;
			if (polls < 3) return json(statusBody());
			return json(statusBody({ state: "succeeded", finishedAt: 9, reportAt: 1767225600000, produced: { markdown: true, json: true } }));
		});

		const res = await ensureReport({ fetchFn: h.fetchFn, sleepFn: h.sleepFn, nowFn: h.nowFn, base: BASE });

		assert.deepStrictEqual(res, { ok: true, reportAt: 1767225600000 });
		assert.strictEqual(h.postCount(), 1, "exactly one trigger POST");
		assert.strictEqual(polls, 3, "polling stops at the terminal state");
	});

	it("treats a 409 (already running) as poll-the-existing-run", async () => {
		let polls = 0;
		const h = harness((path, init) => {
			if (init?.method === "POST") {
				return json({ runId: "r9", state: "running", startedAt: 5 }, 409);
			}
			polls++;
			return polls === 1
				? json(statusBody({ runId: "r9" }))
				: json(statusBody({ runId: "r9", state: "succeeded", produced: { markdown: true, json: false } }));
		});

		const res = await ensureReport({ fetchFn: h.fetchFn, sleepFn: h.sleepFn, nowFn: h.nowFn, base: BASE });

		assert.strictEqual(res.ok, true);
		assert.strictEqual(h.postCount(), 1, "no second POST after a 409");
	});

	it("fails timeout when no terminal state arrives within the budget", async () => {
		const h = harness((path, init) =>
			init?.method === "POST"
				? json({ runId: "r1", state: "running", startedAt: 1 }, 202)
				: json(statusBody()),
		);

		const res = await ensureReport({
			fetchFn: h.fetchFn,
			sleepFn: h.sleepFn,
			nowFn: h.nowFn,
			base: BASE,
			timeoutMs: 1000,
			pollIntervalMs: 250,
		});

		assert.strictEqual(res.ok, false);
		if (res.ok) return;
		assert.strictEqual(res.kind, "timeout");
		assert.ok(h.statusPolls() > 0 && h.statusPolls() < 100, "polling must be bounded");
	});

	it("names analyzer-error when the run fails", async () => {
		const h = harness((path, init) =>
			init?.method === "POST"
				? json({ runId: "r1", state: "running", startedAt: 1 }, 202)
				: json(statusBody({ state: "failed", reason: "analyzer-error", error: "boom" })),
		);

		const res = await ensureReport({ fetchFn: h.fetchFn, sleepFn: h.sleepFn, nowFn: h.nowFn, base: BASE });

		assert.strictEqual(res.ok, false);
		if (res.ok) return;
		assert.strictEqual(res.kind, "run-failed");
		assert.match(res.message, /analyzer-error/);
	});

	it("names no-markdown when the run fails for that reason", async () => {
		const h = harness((path, init) =>
			init?.method === "POST"
				? json({ runId: "r1", state: "running", startedAt: 1 }, 202)
				: json(statusBody({ state: "failed", reason: "no-markdown" })),
		);

		const res = await ensureReport({ fetchFn: h.fetchFn, sleepFn: h.sleepFn, nowFn: h.nowFn, base: BASE });

		assert.strictEqual(res.ok, false);
		if (res.ok) return;
		assert.strictEqual(res.kind, "run-failed");
		assert.match(res.message, /no-markdown/);
	});

	it("fails when success reports no markdown produced", async () => {
		const h = harness((path, init) =>
			init?.method === "POST"
				? json({ runId: "r1", state: "running", startedAt: 1 }, 202)
				: json(statusBody({ state: "succeeded", produced: { markdown: false, json: true } })),
		);

		const res = await ensureReport({ fetchFn: h.fetchFn, sleepFn: h.sleepFn, nowFn: h.nowFn, base: BASE });

		assert.strictEqual(res.ok, false);
		if (res.ok) return;
		assert.strictEqual(res.kind, "run-failed");
		assert.match(res.message, /no markdown/i);
	});

	it("returns the run-route-absent sentinel on POST 404 without polling", async () => {
		const h = harness(() => json({ message: "Not Found" }, 404));

		const res = await ensureReport({ fetchFn: h.fetchFn, sleepFn: h.sleepFn, nowFn: h.nowFn, base: BASE });

		assert.deepStrictEqual(res, { ok: false, kind: "run-route-absent" });
		assert.strictEqual(h.statusPolls(), 0, "must not poll when the route is absent");
	});

	it("names analyzer unavailability on POST 503 without polling", async () => {
		const h = harness(() => json({ reason: "analyzer-unavailable" }, 503));

		const res = await ensureReport({ fetchFn: h.fetchFn, sleepFn: h.sleepFn, nowFn: h.nowFn, base: BASE });

		assert.strictEqual(res.ok, false);
		if (res.ok) return;
		assert.strictEqual(res.kind, "analyzer-unavailable");
		assert.match(res.message, /unavailable/);
		assert.strictEqual(h.statusPolls(), 0, "must not poll an unavailable analyzer");
	});

	it("fails closed on a malformed status body (no unbounded poll)", async () => {
		const h = harness((path, init) =>
			init?.method === "POST" ? json({ runId: "r1", state: "running" }, 202) : json({ state: "running" }),
		);

		const res = await ensureReport({ fetchFn: h.fetchFn, sleepFn: h.sleepFn, nowFn: h.nowFn, base: BASE });

		assert.strictEqual(res.ok, false);
		if (res.ok) return;
		assert.strictEqual(res.kind, "run-failed");
		assert.match(res.message, /malformed/);
		assert.strictEqual(h.statusPolls(), 1);
	});

	it("fails closed on an unknown run state", async () => {
		const h = harness((path, init) =>
			init?.method === "POST"
				? json({ runId: "r1", state: "running" }, 202)
				: json(statusBody({ state: "exploded" })),
		);

		const res = await ensureReport({ fetchFn: h.fetchFn, sleepFn: h.sleepFn, nowFn: h.nowFn, base: BASE });

		assert.strictEqual(res.ok, false);
		if (res.ok) return;
		assert.strictEqual(res.kind, "run-failed");
		assert.match(res.message, /unknown state/);
	});

	it("surfaces an abort during polling", async () => {
		const controller = new AbortController();
		let first = true;
		const h = harness((path, init) => {
			if (init?.method === "POST") return json({ runId: "r1", state: "running" }, 202);
			if (first) {
				first = false;
				return json(statusBody());
			}
			controller.abort(new Error("cancelled"));
			return json(statusBody());
		});

		await assert.rejects(
			() => ensureReport({ fetchFn: h.fetchFn, sleepFn: h.sleepFn, nowFn: h.nowFn, base: BASE, signal: controller.signal }),
			/cancelled/,
		);
	});

	it("bounds a stalled trigger request and fails as timeout", async () => {
		const h = harness(() => json(statusBody()));
		const hanging: RunFetchFn = (_url, init) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
				signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
			});

		const start = Date.now();
		const res = await ensureReport({
			fetchFn: hanging,
			sleepFn: h.sleepFn,
			nowFn: h.nowFn,
			base: BASE,
			timeoutMs: 40,
		});

		assert.strictEqual(res.ok, false);
		if (res.ok) return;
		assert.strictEqual(res.kind, "timeout");
		assert.ok(Date.now() - start < 5000, "a stalled trigger must not hang");
		assert.strictEqual(h.statusPolls(), 0, "must not poll after a stalled trigger");
	});

	it("bounds a stalled status request and fails as timeout", async () => {
		const h = harness(() => json(statusBody()));
		const hanging: RunFetchFn = async (url, init) => {
			if (init?.method === "POST") return json({ runId: "r1", state: "running" }, 202);
			return new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
				signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
			});
		};

		const start = Date.now();
		const res = await ensureReport({
			fetchFn: hanging,
			sleepFn: h.sleepFn,
			nowFn: h.nowFn,
			base: BASE,
			timeoutMs: 40,
		});

		assert.strictEqual(res.ok, false);
		if (res.ok) return;
		assert.strictEqual(res.kind, "timeout");
		assert.ok(Date.now() - start < 5000, "a stalled status request must not hang");
	});

	it("bounds a stalled response body inside the deadline", async () => {
		const h = harness(() => json(statusBody()));
		const stalledBody: RunFetchFn = async (url, init) => {
			if (init?.method === "POST") return json({ runId: "r1", state: "running" }, 202);
			const signal = init?.signal;
			const stream = new ReadableStream({
				start(controller) {
					signal?.addEventListener(
						"abort",
						() => controller.error(signal.reason ?? new Error("aborted")),
						{ once: true },
					);
				},
			});
			return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
		};

		const start = Date.now();
		const res = await ensureReport({
			fetchFn: stalledBody,
			sleepFn: h.sleepFn,
			nowFn: h.nowFn,
			base: BASE,
			timeoutMs: 40,
		});

		assert.strictEqual(res.ok, false);
		if (res.ok) return;
		assert.strictEqual(res.kind, "timeout");
		assert.ok(Date.now() - start < 5000, "a stalled response body must not hang");
	});
});

describe("parseRunStatus", () => {
	it("decodes a valid body and rejects unusable shapes", () => {
		const ok = parseRunStatus({
			runId: "r1",
			state: "succeeded",
			startedAt: 1,
			finishedAt: 2,
			reason: null,
			error: null,
			reportAt: 3,
			produced: { markdown: true, json: false },
		});
		assert.ok(ok);
		assert.strictEqual(ok.state, "succeeded");
		assert.deepStrictEqual(ok.produced, { markdown: true, json: false });

		assert.strictEqual(parseRunStatus(null), null);
		assert.strictEqual(parseRunStatus({ state: "idle" }), null, "missing produced is malformed");
		assert.strictEqual(parseRunStatus({ state: 1, produced: { markdown: true } }), null);
	});
});
