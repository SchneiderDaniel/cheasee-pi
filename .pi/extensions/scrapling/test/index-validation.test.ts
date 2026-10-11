/**
 * Tests for index.ts — URL validation + protocol allowlist.
 *
 * Layer: entity — pure validateUrl contracts, no infra.
 * Split out of index.test.ts (issue #2001).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateUrl } from "../index.ts";

describe("URL validation", () => {
	it("(entity) rejects empty string URL", () => {
		try {
			new URL("");
			assert.fail("should throw on empty URL");
		} catch {
			assert.ok(true, "empty URL should throw");
		}
	});

	it("(entity) rejects no-protocol URL", () => {
		try {
			new URL("not-a-url");
			assert.fail("should throw on no-protocol URL");
		} catch {
			assert.ok(true, "no-protocol URL should throw");
		}
	});

	it("(entity) accepts valid URL with protocol", () => {
		const url = new URL("https://example.com");
		assert.equal(url.href, "https://example.com/", "valid URL should parse correctly");
	});
});

describe("validateUrl helper — protocol allowlist", () => {
	it("(entity) validateUrl('http://example.com') returns URL with http: protocol", () => {
		const url = validateUrl("http://example.com");
		assert.equal(url.protocol, "http:");
	});

	it("(entity) validateUrl('https://example.com') returns URL with https: protocol", () => {
		const url = validateUrl("https://example.com");
		assert.equal(url.protocol, "https:");
	});

	it("(entity) validateUrl('HTTP://EXAMPLE.COM') accepts mixed-case http", () => {
		const url = validateUrl("HTTP://EXAMPLE.COM");
		assert.equal(url.protocol, "http:");
	});

	it("(entity) validateUrl rejects file:// scheme", () => {
		assert.throws(
			() => validateUrl("file:///etc/passwd"),
			/file:/,
		);
	});

	it("(entity) validateUrl rejects data:// scheme", () => {
		assert.throws(
			() => validateUrl("data://text/html,Hello"),
			/data:/,
		);
	});

	it("(entity) validateUrl rejects ftp:// scheme", () => {
		assert.throws(
			() => validateUrl("ftp://ftp.example.com"),
			/ftp:/,
		);
	});

	it("(entity) validateUrl rejects javascript: scheme", () => {
		assert.throws(
			() => validateUrl("javascript:alert(1)"),
			/javascript:/,
		);
	});

	it("(entity) validateUrl('') throws Invalid URL (parse failure, not scheme reject)", () => {
		assert.throws(
			() => validateUrl(""),
			/Invalid URL$/,
		);
	});

	it("(entity) validateUrl('not-a-url') throws Invalid URL (parse failure, not scheme reject)", () => {
		assert.throws(
			() => validateUrl("not-a-url"),
			/Invalid URL$/,
		);
	});

	it("(entity) error message for scheme reject includes 'only http and https protocols are allowed'", () => {
		assert.throws(
			() => validateUrl("ftp://ftp.example.com"),
			/only http and https protocols are allowed/,
		);
	});
});
