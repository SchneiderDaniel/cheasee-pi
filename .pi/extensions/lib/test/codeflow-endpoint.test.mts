/**
 * Tests for .pi/extensions/lib/codeflow-endpoint.ts — compose-internal
 * CodeFlow service URL resolution.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/test/codeflow-endpoint.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { codeflowServiceUrl, CODEFLOW_SERVICE_PORT } from "../codeflow-endpoint.ts";

const MODULE_PATH = resolve(import.meta.dirname, "..", "codeflow-endpoint.ts");

afterEach(() => {
	delete process.env.CODEFLOW_SERVICE_HOST;
});

describe("codeflowServiceUrl", () => {
	it("defaults to the compose service DNS name on the container port", () => {
		delete process.env.CODEFLOW_SERVICE_HOST;
		assert.strictEqual(codeflowServiceUrl(), `http://codeflow:${CODEFLOW_SERVICE_PORT}`);
		assert.strictEqual(CODEFLOW_SERVICE_PORT, 8470);
	});

	it("honours CODEFLOW_SERVICE_HOST overrides", () => {
		process.env.CODEFLOW_SERVICE_HOST = "172.21.0.3";
		assert.strictEqual(codeflowServiceUrl(), "http://172.21.0.3:8470");
		process.env.CODEFLOW_SERVICE_HOST = "localhost";
		assert.strictEqual(codeflowServiceUrl(), "http://localhost:8470");
	});

	it("normalizes a trailing slash", () => {
		process.env.CODEFLOW_SERVICE_HOST = "codeflow/";
		assert.strictEqual(codeflowServiceUrl(), "http://codeflow:8470");
	});

	it("rejects empty, whitespace, scheme-bearing, path-bearing and control-char hosts", () => {
		for (const bad of ["", "   ", "http://x", "codeflow/api", "co deflow", "codeflow\rhack", "\u0000"]) {
			process.env.CODEFLOW_SERVICE_HOST = bad;
			assert.throws(
				() => codeflowServiceUrl(),
				/host/i,
				`codeflowServiceUrl() must reject ${JSON.stringify(bad)}`,
			);
		}
	});

	it("does not import the host-port resolver (confusion guard)", () => {
		const source = readFileSync(MODULE_PATH, "utf-8");
		const imports = source.split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
		assert.ok(!imports.includes("codeflowHostPort"), "must not import codeflowHostPort");
		assert.ok(!imports.includes("context-info/codeflow"), "must not import context-info/codeflow");
	});
});
