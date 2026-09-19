/**
 * Canonical tests for lib/path-containment.ts
 *
 * Single source of truth for the CWE-22 containment predicate. Covers the
 * paths that must be accepted (base itself, children, descendants), the
 * escapes that must be rejected (siblings, `..`-equal, `..`-prefixed,
 * absolute outside root, unnormalized input), and the fail-closed
 * `resolveWithinRoot` contract (canonicalization + raw-value error message).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lib/path-containment.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { basename, dirname, resolve } from "node:path";
import { isPathWithinBase, resolveWithinRoot } from "../path-containment.ts";

const BASE = resolve("/srv/proj");
const SIBLING = resolve(BASE + "-evil");

describe("isPathWithinBase", () => {
	it("accepts a path equal to the base", () => {
		assert.equal(isPathWithinBase(resolve(BASE), BASE), true);
	});

	it("accepts a direct child", () => {
		assert.equal(isPathWithinBase(resolve(BASE, "sub"), BASE), true);
	});

	it("accepts a deep descendant", () => {
		assert.equal(isPathWithinBase(resolve(BASE, "sub", "deep", "x.js"), BASE), true);
	});

	it("rejects the sibling-prefix case (/srv/proj-evil vs /srv/proj)", () => {
		assert.equal(isPathWithinBase(SIBLING, BASE), false);
	});

	it("rejects `..`-equal", () => {
		assert.equal(isPathWithinBase(resolve(BASE, ".."), BASE), false);
	});

	it("rejects `..`-prefixed", () => {
		assert.equal(isPathWithinBase(resolve(BASE, "..", "evil"), BASE), false);
	});

	it("rejects an absolute path outside the base", () => {
		assert.equal(isPathWithinBase("/etc", BASE), false);
	});

	it("rejects unnormalized input (check-after-normalize)", () => {
		assert.equal(isPathWithinBase(BASE + "/../evil", BASE), false);
	});

	it("rejects a path with an embedded `..` that escapes", () => {
		assert.equal(isPathWithinBase(resolve(BASE, "sub/../../evil"), BASE), false);
	});

	it(
		"rejects a cross-drive absolute path (Windows only)",
		{ skip: process.platform !== "win32" },
		() => {
			assert.equal(isPathWithinBase("D:\\x", "C:\\base"), false);
		},
	);
});

describe("resolveWithinRoot", () => {
	it("canonicalizes a child with a trailing slash", () => {
		assert.equal(resolveWithinRoot(BASE, "sub/"), resolve(BASE, "sub"));
	});

	it("canonicalizes a `./`-prefixed child to the same value", () => {
		assert.equal(resolveWithinRoot(BASE, "./sub"), resolveWithinRoot(BASE, "sub"));
	});

	it("returns the base for `.`", () => {
		assert.equal(resolveWithinRoot(BASE, "."), resolve(BASE));
	});

	it("returns the base for an empty string", () => {
		assert.equal(resolveWithinRoot(BASE, ""), resolve(BASE));
	});

	it("accepts an absolute in-root directory", () => {
		assert.equal(resolveWithinRoot(BASE, resolve(BASE, "sub")), resolve(BASE, "sub"));
	});

	const escapes = [
		"../../etc",
		"..",
		"../../../../tmp",
		"subdir/../../../../etc",
		"/",
		`../${basename(BASE)}-evil`,
	];

	for (const escape of escapes) {
		it(`throws for "${escape}" and quotes the raw value`, () => {
			assert.throws(
				() => resolveWithinRoot(BASE, escape),
				(err: Error) => {
					assert.match(err.message, /Directory traversal detected/);
					assert.ok(
						err.message.includes(`"${escape}"`),
						`message should quote raw input "${escape}", got: ${err.message}`,
					);
					return true;
				},
			);
		});
	}

	it("derives sibling escape from dirname(base), not a string suffix", () => {
		const tmpBase = resolve(dirname(BASE), basename(BASE) + "-evil");
		assert.equal(tmpBase, SIBLING);
	});
});
