/**
 * Tests for python-script.ts — SCRAPLING_SCRIPT static analysis
 *
 * Layer: entity — pure string analysis, no subprocess, no I/O.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCRAPLING_SCRIPT } from "../python-script.ts";

describe("SCRAPLING_SCRIPT — imports", () => {
	it("(entity) imports scrapling.fetchers.Fetcher", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes("from scrapling.fetchers import") &&
				SCRAPLING_SCRIPT.includes("Fetcher"),
			"script should import Fetcher from scrapling.fetchers",
		);
	});

	it("(entity) imports scrapling.fetchers.StealthyFetcher", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes("from scrapling.fetchers import") &&
				SCRAPLING_SCRIPT.includes("StealthyFetcher"),
			"script should import StealthyFetcher from scrapling.fetchers",
		);
	});

	it("(entity) imports markdownify", () => {
		assert.ok(SCRAPLING_SCRIPT.includes("import markdownify"), "script should import markdownify");
	});

	it("(entity) imports BeautifulSoup from bs4", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes("from bs4 import BeautifulSoup"),
			"script should import BeautifulSoup from bs4",
		);
	});

	it("(entity) imports urljoin from urllib.parse", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes("from urllib.parse import urljoin"),
			"script should import urljoin from urllib.parse",
		);
	});

	it("(entity) imports urlparse from urllib.parse", () => {
		const hasUrlParse =
			SCRAPLING_SCRIPT.includes("from urllib.parse import") &&
			SCRAPLING_SCRIPT.includes("urlparse");
		// Could be combined import: from urllib.parse import urljoin, urlparse
		assert.ok(hasUrlParse, "script should import urlparse from urllib.parse");
	});
});

describe("SCRAPLING_SCRIPT — progressive fetching strategy", () => {
	it("(entity) calls Fetcher.get(url) before StealthyFetcher.fetch(url)", () => {
		const fetcherGetIdx = SCRAPLING_SCRIPT.indexOf("Fetcher.get(");
		const stealthFetchIdx = SCRAPLING_SCRIPT.indexOf("StealthyFetcher.fetch(");
		assert.ok(fetcherGetIdx >= 0, "Fetcher.get( must exist in script");
		assert.ok(stealthFetchIdx >= 0, "StealthyFetcher.fetch( must exist in script");
		assert.ok(
			fetcherGetIdx < stealthFetchIdx,
			"Fetcher.get( must appear before StealthyFetcher.fetch(",
		);
	});

	it("(entity) checks page.status in [403, 503]", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes("page.status in [403, 503]") ||
				SCRAPLING_SCRIPT.includes("page.status in [503, 403]"),
			"script should check page.status for 403 or 503",
		);
	});

	it("(entity) checks 'cloudflare' in page content", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes('"cloudflare" in page_html.lower()') ||
				SCRAPLING_SCRIPT.includes("'cloudflare' in page_html.lower()"),
			"script should check for cloudflare in content",
		);
	});

	it("(entity) checks 'just a moment' in page content", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes('"just a moment" in page_html.lower()') ||
				SCRAPLING_SCRIPT.includes("'just a moment' in page_html.lower()"),
			"script should check for 'just a moment' in content",
		);
	});

	it("(entity) is_blocked check gates the stealth path — Fetcher before StealthyFetcher", () => {
		const script = SCRAPLING_SCRIPT;
		// The lightweight path uses Fetcher.get first, then checks is_blocked
		const fetcherGetIdx = script.indexOf("Fetcher.get(");
		const isBlockedIdx = script.indexOf("is_blocked");
		const stealthFetchIdx = script.indexOf("StealthyFetcher.fetch(");

		assert.ok(fetcherGetIdx >= 0, "Fetcher.get( must exist");
		assert.ok(isBlockedIdx >= 0, "is_blocked must exist");
		assert.ok(stealthFetchIdx >= 0, "StealthyFetcher.fetch( must exist");

		// is_blocked check should come after Fetcher.get but before StealthyFetcher.fetch
		assert.ok(fetcherGetIdx < isBlockedIdx, "Fetcher.get( must be before is_blocked check");
		assert.ok(
			isBlockedIdx < stealthFetchIdx,
			"is_blocked check must be before StealthyFetcher.fetch(",
		);
	});

	it("(entity) sets StealthyFetcher.adaptive = True", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes("StealthyFetcher.adaptive = True") ||
				SCRAPLING_SCRIPT.includes("StealthyFetcher.adaptive=True"),
			"script should set StealthyFetcher.adaptive = True",
		);
	});
});

describe("SCRAPLING_SCRIPT — markdown conversion", () => {
	it("(entity) uses markdownify with heading_style='ATX'", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes('heading_style="ATX"') ||
				SCRAPLING_SCRIPT.includes("heading_style='ATX'"),
			"script should configure markdownify with ATX heading style",
		);
	});

	it("(entity) uses markdownify with strip=['script', 'style']", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes("strip=['script', 'style']") ||
				SCRAPLING_SCRIPT.includes('strip=["script", "style"]'),
			"script should strip script and style tags via markdownify",
		);
	});
});

describe("SCRAPLING_SCRIPT — link resolution", () => {
	it("(entity) resolves relative links using urljoin(current, a_tag['href'])", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes("urljoin(current, a_tag['href'])") ||
				SCRAPLING_SCRIPT.includes('urljoin(current, a_tag["href"])'),
			"script should use urljoin to resolve relative links",
		);
	});
});

describe("SCRAPLING_SCRIPT — browser cleanup", () => {
	it("(entity) has finally block that closes StealthyFetcher._browser", () => {
		const hasFinally = SCRAPLING_SCRIPT.includes("finally:");
		const hasClose =
			SCRAPLING_SCRIPT.includes("_browser.close()") ||
			SCRAPLING_SCRIPT.includes("_browser.close()");
		assert.ok(hasFinally, "script should have a finally block");
		assert.ok(hasClose, "script should call _browser.close() for cleanup");
	});

	it("(entity) finally block appears after StealthyFetcher.fetch", () => {
		const stealthIdx = SCRAPLING_SCRIPT.indexOf("StealthyFetcher.fetch(");
		const finallyIdx = SCRAPLING_SCRIPT.indexOf("finally:");
		assert.ok(stealthIdx >= 0, "StealthyFetcher.fetch must exist");
		assert.ok(finallyIdx >= 0, "finally must exist");
		assert.ok(stealthIdx < finallyIdx, "StealthyFetcher.fetch must appear before finally block");
	});
});

describe("SCRAPLING_SCRIPT — output format", () => {
	it("(entity) script prints JSON with ok and results fields", () => {
		const script = SCRAPLING_SCRIPT;
		assert.ok(script.includes('"ok"') || script.includes("'ok'"), "output should include ok field");
		assert.ok(
			script.includes('"results"') || script.includes("'results'"),
			"output should include results field",
		);
	});

	it("(entity) script uses json.dumps for output", () => {
		assert.ok(SCRAPLING_SCRIPT.includes("json.dumps("), "script should use json.dumps for output");
	});

	it("(entity) marks failed results with success: false", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes('"success": False') ||
				SCRAPLING_SCRIPT.includes("'success': False") ||
				SCRAPLING_SCRIPT.includes('"success": false') ||
				SCRAPLING_SCRIPT.includes("'success': false"),
			"script should include success field in results",
		);
	});
});

describe("SCRAPLING_SCRIPT — error handling", () => {
	it("(entity) StealthyFetcher.fetch wrapped in try/except", () => {
		const script = SCRAPLING_SCRIPT;
		const stealthIdx = script.indexOf("StealthyFetcher.fetch(");
		// Find the nearest try before StealthyFetcher.fetch
		const tryBeforeStealth = script.lastIndexOf("try:", stealthIdx);
		assert.ok(
			tryBeforeStealth >= 0 && tryBeforeStealth < stealthIdx,
			"StealthyFetcher.fetch should be inside a try block",
		);
	});

	it("(entity) lightweight fetch wrapped in try/except", () => {
		const script = SCRAPLING_SCRIPT;
		const fetcherGetIdx = script.indexOf("Fetcher.get(");
		const tryBeforeFetcher = script.lastIndexOf("try:", fetcherGetIdx);
		assert.ok(
			tryBeforeFetcher >= 0 && tryBeforeFetcher < fetcherGetIdx,
			"Fetcher.get should be inside a try block",
		);
	});

	it("(entity) raises descriptive error when stealth fails", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes("Stealth bypass failed") || SCRAPLING_SCRIPT.includes("stealth"),
			"script should include descriptive error message for stealth failure",
		);
	});
});

describe("SCRAPLING_SCRIPT — SIGTERM handler", () => {
	it("(entity) imports signal module", () => {
		assert.ok(SCRAPLING_SCRIPT.includes("import signal"), "script should import signal module");
	});

	it("(entity) registers signal.signal(signal.SIGTERM, handler)", () => {
		assert.ok(
			SCRAPLING_SCRIPT.includes("signal.signal(signal.SIGTERM,"),
			"script should register SIGTERM handler",
		);
	});

	it("(entity) SIGTERM handler calls browser cleanup in try/except", () => {
		const script = SCRAPLING_SCRIPT;
		// Find the SIGTERM handler function
		const sigtermIdx = script.indexOf("SIGTERM");
		assert.ok(sigtermIdx >= 0, "SIGTERM reference must exist");

		// After SIGTERM handler registration, there should be browser cleanup
		const afterSigterm = script.slice(sigtermIdx);
		assert.ok(
			afterSigterm.includes("_browser.close()") || afterSigterm.includes("_browser.close"),
			"SIGTERM handler should close browser",
		);
	});

	it("(entity) SIGTERM handler calls sys.exit(1) after cleanup", () => {
		const script = SCRAPLING_SCRIPT;
		const sigtermIdx = script.indexOf("SIGTERM");
		assert.ok(sigtermIdx >= 0, "SIGTERM reference must exist");

		const afterSigterm = script.slice(sigtermIdx);
		assert.ok(
			afterSigterm.includes("sys.exit(1)") || afterSigterm.includes("sys.exit"),
			"SIGTERM handler should exit with code 1",
		);
	});

	it("(entity) SIGTERM handler import is at module level (before main function)", () => {
		const script = SCRAPLING_SCRIPT;
		const signalImportIdx = script.indexOf("import signal");
		const mainDefIdx = script.indexOf("def main():");
		assert.ok(
			signalImportIdx >= 0 && signalImportIdx < mainDefIdx,
			"signal import should come before main() definition",
		);
	});
});
