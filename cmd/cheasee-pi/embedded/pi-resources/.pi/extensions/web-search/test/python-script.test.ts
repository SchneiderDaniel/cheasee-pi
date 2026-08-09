/**
 * Tests for python-script.ts — delimiter markers + SIGTERM handler + config + error handling
 *
 * Layer: (D) Domain — string constants, no infra dependencies.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEARCH_SCRIPT } from "../python-script.ts";

describe("SEARCH_SCRIPT — delimiter markers", () => {
	it("(D) contains SEARCH_OK delimiter before json.dumps output", () => {
		assert.ok(
			SEARCH_SCRIPT.includes('print("SEARCH_OK")'),
			"script should print SEARCH_OK before JSON output",
		);
	});

	it("(D) contains SEARCH_DONE delimiter after json.dumps output", () => {
		assert.ok(
			SEARCH_SCRIPT.includes('print("SEARCH_DONE")'),
			"script should print SEARCH_DONE after JSON output",
		);
	});

	it("(D) SEARCH_OK appears before SEARCH_DONE in script", () => {
		const okIdx = SEARCH_SCRIPT.indexOf('print("SEARCH_OK")');
		const doneIdx = SEARCH_SCRIPT.indexOf('print("SEARCH_DONE")');
		assert.ok(okIdx >= 0, "SEARCH_OK must exist");
		assert.ok(doneIdx >= 0, "SEARCH_DONE must exist");
		assert.ok(okIdx < doneIdx, "SEARCH_OK must appear before SEARCH_DONE");
	});

	it("(D) SEARCH_OK is printed before json.dumps call", () => {
		const okIdx = SEARCH_SCRIPT.indexOf('print("SEARCH_OK")');
		const dumpsIdx = SEARCH_SCRIPT.indexOf("json.dumps");
		assert.ok(okIdx >= 0, "SEARCH_OK must exist");
		assert.ok(dumpsIdx >= 0, "json.dumps must exist");
		assert.ok(okIdx < dumpsIdx, "SEARCH_OK must be printed before json.dumps");
	});
});

describe("SEARCH_SCRIPT — SIGTERM handler", () => {
	it("(D) script imports signal module", () => {
		assert.ok(SEARCH_SCRIPT.includes("import signal"), "script should import the signal module");
	});

	it("(D) script registers SIGTERM handler calling sys.exit(130)", () => {
		assert.ok(
			SEARCH_SCRIPT.includes("signal.signal(signal.SIGTERM") &&
				SEARCH_SCRIPT.includes("sys.exit(130)"),
			"script should register SIGTERM handler that exits with code 130",
		);
	});

	it("(D) script imports json and sys", () => {
		assert.ok(SEARCH_SCRIPT.includes("import json"), "script should import json");
		assert.ok(SEARCH_SCRIPT.includes("import sys"), "script should import sys");
	});
});

describe("SEARCH_SCRIPT — config file read instead of argv JSON parse", () => {
	it("(D) does NOT contain json.loads(sys.argv[1]) — old broken pattern absent", () => {
		assert.ok(
			!SEARCH_SCRIPT.includes("json.loads(sys.argv[1])"),
			"script should NOT parse sys.argv[1] as JSON string; should read from file instead",
		);
	});

	it("(D) contains open(sys.argv[1]) — file path opened for reading", () => {
		assert.ok(
			SEARCH_SCRIPT.includes("open(sys.argv[1])"),
			"script should open the config file path passed as argv[1]",
		);
	});

	it("(D) contains json.load( — deserializes from file handle, not string", () => {
		assert.ok(
			SEARCH_SCRIPT.includes("json.load("),
			"script should use json.load() to read from file handle",
		);
	});

	it("(D) open(sys.argv[1]) appears before json.load( in script — file opened before parsing", () => {
		const openIdx = SEARCH_SCRIPT.indexOf("open(sys.argv[1])");
		const loadIdx = SEARCH_SCRIPT.indexOf("json.load(");
		assert.ok(openIdx >= 0, "open(sys.argv[1]) must exist");
		assert.ok(loadIdx >= 0, "json.load( must exist");
		assert.ok(openIdx < loadIdx, "open(sys.argv[1]) must appear before json.load(");
	});

	it("(D) has with statement around open(sys.argv[1]) — proper resource cleanup", () => {
		const withOpenPattern = /with\s+open\(sys\.argv\[1\]\)\s+as\s+\w+:/;
		assert.ok(
			withOpenPattern.test(SEARCH_SCRIPT),
			"script should have 'with open(sys.argv[1]) as <var>:' for proper resource cleanup",
		);
	});
});

describe("SEARCH_SCRIPT — ddgs usage", () => {
	it("(D) uses DDGS().text(query, max_results=N) with backend='auto'", () => {
		assert.ok(
			SEARCH_SCRIPT.includes('ddgs.text(query, max_results=max_results, backend="auto")'),
			"script should call DDGS().text with query, max_results, and backend='auto'",
		);
	});

	it("(D) uses DDGS(**kwargs) constructor pattern when proxy config present", () => {
		assert.ok(
			SEARCH_SCRIPT.includes("DDGS(**kwargs)"),
			"script should use DDGS(**kwargs) constructor pattern",
		);
	});
});

describe("SEARCH_SCRIPT — config keys", () => {
	it("(D) config keys include query", () => {
		assert.ok(SEARCH_SCRIPT.includes('config["query"]'), "config should have query key");
	});

	it("(D) config keys include max_results", () => {
		assert.ok(
			SEARCH_SCRIPT.includes('config.get("max_results"'),
			"config should have max_results key",
		);
	});

	it("(D) config keys include proxy (optional)", () => {
		assert.ok(
			SEARCH_SCRIPT.includes('config.get("proxy"'),
			"config should have proxy key (optional)",
		);
	});

	it("(D) config keys include timeout (optional, default 5)", () => {
		assert.ok(
			SEARCH_SCRIPT.includes('config.get("timeout"'),
			"config should have timeout key (optional)",
		);
	});
});

describe("SEARCH_SCRIPT — error handling", () => {
	it("(D) has try/except Exception block that prints SEARCH_OK + error JSON + SEARCH_DONE", () => {
		assert.ok(
			SEARCH_SCRIPT.includes("try:") &&
				SEARCH_SCRIPT.includes("except Exception as e:") &&
				SEARCH_SCRIPT.includes('print("SEARCH_OK")') &&
				SEARCH_SCRIPT.includes('print("SEARCH_DONE")'),
			"script should have try/except Exception block with SEARCH_OK, error JSON, and SEARCH_DONE",
		);
	});

	it("(D) on error, outputs error key in JSON", () => {
		assert.ok(
			SEARCH_SCRIPT.includes('"error": str(e)'),
			"script should include error message in JSON output",
		);
	});
});

describe("SEARCH_SCRIPT — result shape matches SearchResult", () => {
	it("(D) result dict has title key", () => {
		assert.ok(SEARCH_SCRIPT.includes('"title"'), "result should have title field");
	});

	it("(D) result dict has url key (mapped from href)", () => {
		assert.ok(
			SEARCH_SCRIPT.includes('"url"') && SEARCH_SCRIPT.includes('r.get("href"'),
			"result should have url field mapped from ddgs href",
		);
	});

	it("(D) result dict has snippet key (mapped from body)", () => {
		assert.ok(
			SEARCH_SCRIPT.includes('"snippet"') && SEARCH_SCRIPT.includes('r.get("body"'),
			"result should have snippet field mapped from ddgs body",
		);
	});
});
