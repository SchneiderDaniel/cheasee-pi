/**
 * Tests for .pi/extensions/context-info/test/helpers.ts — the shared fixtures
 * for the context-info suites.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/helpers.test.mts
 */

import assert from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeBareWithRemote, makeWorkspace, withEnvVar } from "./helpers.ts";

describe("makeWorkspace", () => {
	it("creates <prefix>.../ws/cheasee-settings.json with root under the prefix", () => {
		const { root, parent } = makeWorkspace("helpers-a-");
		assert.ok(parent.startsWith(tmpdir()), "temp dir under the OS tmpdir");
		assert.ok(parent.includes("helpers-a-"), "prefix honoured");
		assert.strictEqual(root, join(parent, "ws"));
		assert.ok(existsSync(join(root, "cheasee-settings.json")), "marker file exists");
	});

	it("writes the given content verbatim and defaults to '{}'", () => {
		const content = `{"docker":{"uiPort":"9600"}}`;
		const withContent = makeWorkspace("helpers-b-", content);
		assert.strictEqual(readFileSync(join(withContent.root, "cheasee-settings.json"), "utf-8"), content);
		const defaulted = makeWorkspace("helpers-c-");
		assert.strictEqual(readFileSync(join(defaulted.root, "cheasee-settings.json"), "utf-8"), "{}");
	});

	it("two calls yield independent directories", () => {
		const a = makeWorkspace("helpers-d-");
		const b = makeWorkspace("helpers-d-");
		assert.notStrictEqual(a.root, b.root);
	});
});

describe("makeBareWithRemote", () => {
	it("creates <parent>/.bare with remote.origin.url set", () => {
		const { parent } = makeWorkspace("helpers-e-");
		makeBareWithRemote(parent, "git@github.com:alice/foo.git");
		const url = execSync(`git --git-dir "${join(parent, ".bare")}" config --get remote.origin.url`, {
			encoding: "utf-8",
		}).trim();
		assert.strictEqual(url, "git@github.com:alice/foo.git");
	});
});

describe("withEnvVar", () => {
	const KEY = "CONTEXT_INFO_HELPERS_TEST";
	const OTHER = "CONTEXT_INFO_HELPERS_OTHER";

	it("sets the named var during fn and restores the prior value", async () => {
		process.env[KEY] = "prior";
		let seen: string | undefined;
		await withEnvVar(KEY, "during", async () => {
			seen = process.env[KEY];
		});
		assert.strictEqual(seen, "during");
		assert.strictEqual(process.env[KEY], "prior");
		delete process.env[KEY];
	});

	it("deletes the var when the value is undefined", async () => {
		process.env[KEY] = "prior";
		let during: string | undefined = "unset";
		await withEnvVar(KEY, undefined, async () => {
			during = process.env[KEY];
		});
		assert.strictEqual(during, undefined);
		assert.strictEqual(process.env[KEY], "prior");
		delete process.env[KEY];
	});

	it("restores the prior value even when fn throws", async () => {
		process.env[KEY] = "prior";
		await assert.rejects(
			withEnvVar(KEY, "during", async () => {
				throw new Error("boom");
			}),
		);
		assert.strictEqual(process.env[KEY], "prior");
		delete process.env[KEY];
	});

	it("touches no other env key", async () => {
		process.env[OTHER] = "untouched";
		await withEnvVar(KEY, "during", async () => {});
		assert.strictEqual(process.env[OTHER], "untouched");
		delete process.env[OTHER];
	});
});
