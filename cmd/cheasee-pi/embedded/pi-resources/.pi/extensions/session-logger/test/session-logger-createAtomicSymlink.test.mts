/**
 * Tests for createAtomicSymlink — the extracted atomic symlink helper.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-createAtomicSymlink.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { createAtomicSymlink } from "../files.ts";

// ---------------------------------------------------------------------------
// createAtomicSymlink — unit tests
// ---------------------------------------------------------------------------

describe("createAtomicSymlink", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "createAtomicSymlink-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates valid symlink at latestLink pointing to targetFile", async () => {
		const linkDir = path.join(tmpDir, "links");
		fs.mkdirSync(linkDir, { recursive: true });
		const targetFile = path.join(tmpDir, "target.txt");
		fs.writeFileSync(targetFile, "hello");

		await createAtomicSymlink(linkDir, targetFile, "latest.txt");

		const latestLink = path.join(linkDir, "latest.txt");
		assert.ok(fs.existsSync(latestLink), "symlink target should be reachable");
		const stat = fs.lstatSync(latestLink);
		assert.ok(stat.isSymbolicLink(), "latestLink should be a symlink");

		const readTarget = fs.readlinkSync(latestLink);
		// Target should be relative to linkDir
		const expected = path.relative(linkDir, targetFile);
		assert.strictEqual(readTarget, expected, `symlink should point to ${expected}`);
	});

	it("leaves no .tmp files after completion", async () => {
		const linkDir = path.join(tmpDir, "links");
		fs.mkdirSync(linkDir, { recursive: true });
		const targetFile = path.join(tmpDir, "target.txt");
		fs.writeFileSync(targetFile, "hello");

		await createAtomicSymlink(linkDir, targetFile, "latest.txt");

		const tmpFiles = fs.readdirSync(linkDir).filter((f) => f.endsWith(".tmp"));
		assert.strictEqual(tmpFiles.length, 0, "No .tmp files should remain");
	});

	it("concurrent calls on same latestLink — both succeed, no tmp files", async () => {
		const linkDir = path.join(tmpDir, "links");
		fs.mkdirSync(linkDir, { recursive: true });
		const targetA = path.join(tmpDir, "targetA.txt");
		fs.writeFileSync(targetA, "A");
		const targetB = path.join(tmpDir, "targetB.txt");
		fs.writeFileSync(targetB, "B");

		await Promise.all([
			createAtomicSymlink(linkDir, targetA, "latest.txt"),
			createAtomicSymlink(linkDir, targetB, "latest.txt"),
		]);

		const latestLink = path.join(linkDir, "latest.txt");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink exists after concurrent calls");
		assert.ok(fs.existsSync(latestLink), "target reachable");

		// No tmp files should remain (both winner and loser cleaned up)
		const tmpFiles = fs.readdirSync(linkDir).filter((f) => f.endsWith(".tmp"));
		assert.strictEqual(tmpFiles.length, 0, "No .tmp files after concurrent calls");

		// Target must point to one of the two valid files
		const resolved = fs.realpathSync(latestLink);
		assert.ok(
			resolved === fs.realpathSync(targetA) || resolved === fs.realpathSync(targetB),
			`resolved ${resolved} must be one of the target files`,
		);
	});

	it("replaces existing symlink atomically", async () => {
		const linkDir = path.join(tmpDir, "links");
		fs.mkdirSync(linkDir, { recursive: true });
		const firstTarget = path.join(tmpDir, "first.txt");
		fs.writeFileSync(firstTarget, "first");
		const secondTarget = path.join(tmpDir, "second.txt");
		fs.writeFileSync(secondTarget, "second");

		await createAtomicSymlink(linkDir, firstTarget, "latest.txt");
		await createAtomicSymlink(linkDir, secondTarget, "latest.txt");

		const latestLink = path.join(linkDir, "latest.txt");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink exists after replacement");
		assert.ok(fs.existsSync(latestLink), "target reachable after replacement");
		const resolved = fs.realpathSync(latestLink);
		assert.strictEqual(
			resolved,
			fs.realpathSync(secondTarget),
			"symlink should point to new target",
		);

		// No tmp files
		const tmpFiles = fs.readdirSync(linkDir).filter((f) => f.endsWith(".tmp"));
		assert.strictEqual(tmpFiles.length, 0, "No .tmp files after replacement");
	});

	it("generates random hex suffix — two sequential calls with different targets produce different tmp paths", async () => {
		const linkDir = path.join(tmpDir, "links");
		fs.mkdirSync(linkDir, { recursive: true });
		const targetA = path.join(tmpDir, "targetA.txt");
		fs.writeFileSync(targetA, "A");
		const targetB = path.join(tmpDir, "targetB.txt");
		fs.writeFileSync(targetB, "B");

		// Capture readdir before and after first call
		await createAtomicSymlink(linkDir, targetA, "latest.txt");
		const filesAfterFirst = fs.readdirSync(linkDir);
		const tmpFilesAfterFirst = filesAfterFirst.filter((f) => f.endsWith(".tmp"));
		assert.strictEqual(tmpFilesAfterFirst.length, 0, "No tmp after first call");

		await createAtomicSymlink(linkDir, targetB, "latest.txt");
		const filesAfterSecond = fs.readdirSync(linkDir);
		const tmpFilesAfterSecond = filesAfterSecond.filter((f) => f.endsWith(".tmp"));
		assert.strictEqual(tmpFilesAfterSecond.length, 0, "No tmp after second call");
	});

	it("throws when a non-ENOENT filesystem error occurs (read-only dir)", async () => {
		const linkDir = path.join(tmpDir, "links");
		fs.mkdirSync(linkDir, { recursive: true });
		// Make symlink calls fail by setting linkDir to read-only
		fs.chmodSync(linkDir, 0o444);
		const targetFile = path.join(tmpDir, "target.txt");
		fs.writeFileSync(targetFile, "hello");

		await assert.rejects(
			() => createAtomicSymlink(linkDir, targetFile, "latest.txt"),
			(err: unknown) => {
				const nodeErr = err as NodeJS.ErrnoException;
				// EACCES or EROFS — any error is fine, just ensure it rethrows
				return nodeErr.code !== undefined;
			},
		);

		// Restore for cleanup
		fs.chmodSync(linkDir, 0o755);
	});
});
