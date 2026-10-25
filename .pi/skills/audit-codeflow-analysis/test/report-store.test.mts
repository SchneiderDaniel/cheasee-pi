// ─── Report store + bridge client (issue #2033 split) ───────────────
// `fetch-report.ts` keeps the use case; the filesystem half lives in
// `lib/report-store.ts` and the HTTP half in `lib/bridge-client.ts`. These are
// the adapter contracts the use case relies on, pinned at the seam.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decodeBody,
	defaultWriteFile,
	removeStaleArtifact,
	writeAtomically,
} from "../lib/report-store.ts";
import { fetchBridgeStatus, getReport, jsonUnavailableWarning } from "../lib/bridge-client.ts";
import type { FetchFn, WriteFileFn } from "../lib/report-types.ts";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "report-store-"));

const encoder = new TextEncoder();

describe("report-store: writeAtomically", () => {
	it("writes the bytes and leaves no temp file behind", () => {
		const cwd = tempDir();
		const target = join(cwd, "ignore", "report.json");
		writeAtomically(defaultWriteFile, cwd, target, encoder.encode('{"a":1}'));
		assert.equal(readFileSync(target, "utf-8"), '{"a":1}');
		assert.deepEqual(readdirSync(join(cwd, "ignore")), ["report.json"]);
	});

	it("fails closed when the parent directory resolves outside the root", () => {
		const cwd = tempDir();
		const outside = tempDir();
		mkdirSync(join(cwd, "ignore"));
		symlinkSync(outside, join(cwd, "ignore", "escape"));
		assert.throws(
			() =>
				writeAtomically(
					defaultWriteFile,
					cwd,
					join(cwd, "ignore", "escape", "report.json"),
					encoder.encode("x"),
				),
			/symlink escape/,
		);
		assert.deepEqual(readdirSync(outside), [], "nothing may be written outside the root");
	});

	it("propagates a write failure and removes the temp file", () => {
		const cwd = tempDir();
		const target = join(cwd, "ignore", "report.json");
		const boom: WriteFileFn = () => {
			throw new Error("disk on fire");
		};
		assert.throws(() => writeAtomically(boom, cwd, target, encoder.encode("x")), /disk on fire/);
		assert.deepEqual(readdirSync(join(cwd, "ignore")), [], "no *.tmp may survive a failed write");
	});
});

describe("report-store: removeStaleArtifact", () => {
	it("returns false when the artifact is absent", () => {
		const cwd = tempDir();
		assert.equal(removeStaleArtifact(cwd, join(cwd, "ignore", "report.json")), false);
	});

	it("removes a present artifact and returns true", () => {
		const cwd = tempDir();
		const target = join(cwd, "ignore", "report.json");
		writeAtomically(defaultWriteFile, cwd, target, encoder.encode("{}"));
		assert.equal(removeStaleArtifact(cwd, target), true);
		assert.equal(existsSync(target), false);
	});
});

describe("report-store: decodeBody", () => {
	it("decodes UTF-8 bytes", () => {
		assert.equal(decodeBody(encoder.encode("# Bericht — 42")), "# Bericht — 42");
	});
});

describe("bridge-client", () => {
	const base = "http://127.0.0.1:1";

	it("getReport returns the response and reports a transport failure", async () => {
		const ok: FetchFn = async () => new Response("{}", { status: 200 });
		assert.equal((await getReport(ok, base)).status, 200);
		const down: FetchFn = async () => {
			throw new Error("ECONNREFUSED");
		};
		await assert.rejects(() => getReport(down, base), /ECONNREFUSED/);
	});

	it("fetchBridgeStatus returns null for a non-ok response and for an unreachable shim", async () => {
		const missing: FetchFn = async () => new Response("", { status: 500 });
		assert.equal(await fetchBridgeStatus(missing, base), null);
		const down: FetchFn = async () => {
			throw new Error("ECONNREFUSED");
		};
		assert.equal(await fetchBridgeStatus(down, base), null);
	});

	it("jsonUnavailableWarning distinguishes a capture gap from a route fault", async () => {
		const captured: FetchFn = async () =>
			Response.json({ "/api/analysis/report.json": { postedAt: null, capturedAt: "t0" } });
		assert.match(await jsonUnavailableWarning(captured, base), /capture-side gap/);
		const posted: FetchFn = async () =>
			Response.json({ "/api/analysis/report.json": { postedAt: "t1", httpStatus: 404 } });
		assert.match(await jsonUnavailableWarning(posted, base), /received the JSON export/);
		const blind: FetchFn = async () => new Response("", { status: 500 });
		assert.match(await jsonUnavailableWarning(blind, base), /cannot be determined/);
	});
});
