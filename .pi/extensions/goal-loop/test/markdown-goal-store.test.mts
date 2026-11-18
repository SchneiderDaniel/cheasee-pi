// ─── Phase 8: Markdown goal store adapter ────────────────────────
// R2: one uniquely named Markdown record under the ORIGINAL checkout's
// `ignore/` directory, atomically written, fail-closed parsed, never committed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownGoalStore } from "../adapters/markdown-goal-store.ts";
import { serializeGoalRecord } from "../domain/goal-record-markdown.ts";
import { realGit } from "../../supervisor/test/helpers/git-harness.mts";
import { buildRecord } from "./helpers/builders.mts";

const RECORD_ID = "20260102-030405-add-a-feature-abcd";

function makeCheckout(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "goal-store-"));
	writeFileSync(join(dir, ".gitignore"), "ignore/\nnode_modules\n");
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("MarkdownGoalStore", () => {
	it("writes ignore/goals/<id>.md and reads it back deep-equal", async () => {
		const fixture = makeCheckout();
		try {
			const store = new MarkdownGoalStore(fixture.dir);
			const record = buildRecord({ id: RECORD_ID });
			const written = await store.write(record);
			assert.equal(written.ok, true);

			const path = join(fixture.dir, "ignore/goals", `${RECORD_ID}.md`);
			assert.equal(existsSync(path), true);

			const read = await store.read(RECORD_ID);
			assert.equal(read.ok, true);
			if (read.ok) assert.deepEqual(read.value, record);
		} finally {
			fixture.cleanup();
		}
	});

	it("replaces atomically and leaves no temp residue", async () => {
		const fixture = makeCheckout();
		try {
			const store = new MarkdownGoalStore(fixture.dir);
			await store.write(buildRecord({ id: RECORD_ID, iterations: 1 }));
			await store.write(buildRecord({ id: RECORD_ID, iterations: 2 }));

			const entries = readdirSync(join(fixture.dir, "ignore/goals"));
			assert.equal(entries.filter((entry) => entry.endsWith(".md")).length, 1);
			assert.equal(entries.filter((entry) => entry.endsWith(".tmp")).length, 0);

			const read = await store.read(RECORD_ID);
			assert.equal(read.ok, true);
			if (read.ok) assert.equal(read.value.iterations, 2);
		} finally {
			fixture.cleanup();
		}
	});

	it("fails closed on truncated front matter and names the file", async () => {
		const fixture = makeCheckout();
		try {
			const store = new MarkdownGoalStore(fixture.dir);
			await store.write(buildRecord({ id: RECORD_ID }));
			const path = join(fixture.dir, "ignore/goals", `${RECORD_ID}.md`);
			writeFileSync(path, '---\nid: "x"\nstatus: active\n');

			const read = await store.read(RECORD_ID);
			assert.equal(read.ok, false);
			if (!read.ok) assert.match(read.error, new RegExp(RECORD_ID));
		} finally {
			fixture.cleanup();
		}
	});

	it("fails closed on a missing required key and on an unknown status", async () => {
		const fixture = makeCheckout();
		try {
			const store = new MarkdownGoalStore(fixture.dir);
			const record = buildRecord({ id: RECORD_ID });
			const path = join(fixture.dir, "ignore/goals", `${RECORD_ID}.md`);
			await store.write(record);

			rewriteWithoutKey(fixture.dir, record.id, "resets");
			const missing = await store.read(RECORD_ID);
			assert.equal(missing.ok, false);
			if (!missing.ok) assert.match(missing.error, /missing required front-matter key "resets"/);

			writeFileSync(
				path,
				serializeGoalRecord(record).replace('status: "clarifying"', 'status: "nope"'),
			);
			const unknown = await store.read(RECORD_ID);
			assert.equal(unknown.ok, false);
			if (!unknown.ok) assert.match(unknown.error, /unknown goal status/);
		} finally {
			fixture.cleanup();
		}
	});

	it("regenerates loop sections while keeping the agent's own section", async () => {
		const fixture = makeCheckout();
		try {
			const store = new MarkdownGoalStore(fixture.dir);
			const record = buildRecord({ id: RECORD_ID, iterations: 1 });
			await store.write(record);

			const path = join(fixture.dir, "ignore/goals", `${RECORD_ID}.md`);
			writeFileSync(path, serializeGoalRecord(record, "agent hand-written note"));
			await store.write({ ...record, iterations: 2 });

			const text = readFileSync(path, "utf-8");
			assert.match(text, /- iterations: 2/);
			assert.match(text, /agent hand-written note/);
		} finally {
			fixture.cleanup();
		}
	});

	it("lists only *.md records and ignores .lock plus stray files", async () => {
		const fixture = makeCheckout();
		try {
			const store = new MarkdownGoalStore(fixture.dir);
			await store.write(buildRecord({ id: RECORD_ID, status: "active" }));
			await store.write(buildRecord({ id: "20260102-030500-other-goal-bbbb", status: "complete" }));
			writeFileSync(join(fixture.dir, "ignore/goals/.lock"), "{}");
			writeFileSync(join(fixture.dir, "ignore/goals/notes.txt"), "hi");

			const listed = await store.list();
			assert.equal(listed.ok, true);
			if (!listed.ok) return;
			assert.equal(listed.value.length, 2);
			assert.deepEqual(listed.value.map((r) => r.status).sort(), ["active", "complete"]);
		} finally {
			fixture.cleanup();
		}
	});

	it("resolves the record path under the original checkout, not the process cwd", async () => {
		const fixture = makeCheckout();
		try {
			const store = new MarkdownGoalStore(fixture.dir);
			const path = store.pathFor(RECORD_ID);
			assert.equal(path, join(fixture.dir, "ignore/goals", `${RECORD_ID}.md`));
			assert.equal(path.startsWith(process.cwd()), false);
		} finally {
			fixture.cleanup();
		}
	});

	it("writes a record git refuses to track", async () => {
		const fixture = makeCheckout();
		try {
			await realGit(fixture.dir, ["init", "-b", "main"]);
			await realGit(fixture.dir, ["config", "user.email", "test@example.com"]);
			await realGit(fixture.dir, ["config", "user.name", "Test"]);
			await realGit(fixture.dir, ["add", ".gitignore"]);
			await realGit(fixture.dir, ["commit", "-m", "base"]);

			const store = new MarkdownGoalStore(fixture.dir);
			await store.write(buildRecord({ id: RECORD_ID }));
			const path = store.pathFor(RECORD_ID);

			assert.doesNotThrow(() => execFileSync("git", ["check-ignore", path], { cwd: fixture.dir }));
			const status = execFileSync("git", ["status", "--porcelain"], {
				cwd: fixture.dir,
				encoding: "utf-8",
			});
			assert.equal(status.trim(), "", "the record never appears as untracked");
		} finally {
			fixture.cleanup();
		}
	});

	it("refuses a lock held by a live process and takes over a stale one", async () => {
		const fixture = makeCheckout();
		try {
			const store = new MarkdownGoalStore(fixture.dir);
			const lockPath = join(fixture.dir, "ignore/goals/.lock");

			// pid 1 is always alive in this container.
			await store.write(buildRecord({ id: RECORD_ID }));
			writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00.000Z" }));
			const refused = await store.acquire();
			assert.equal(refused.ok, false);
			if (!refused.ok) assert.match(refused.error, /goal lock held by pid 1/);

			writeFileSync(
				lockPath,
				JSON.stringify({ pid: 999_999, startedAt: "2026-01-01T00:00:00.000Z" }),
			);
			const taken = await store.acquire();
			assert.equal(taken.ok, true);
			if (taken.ok) {
				const payload = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid: number };
				assert.equal(payload.pid, process.pid);
			}
			await store.release();
			assert.equal(existsSync(lockPath), false);
		} finally {
			fixture.cleanup();
		}
	});

	it("rejects a traversal id before any write", async () => {
		const fixture = makeCheckout();
		try {
			const store = new MarkdownGoalStore(fixture.dir);
			assert.throws(() => store.pathFor("../escape"), /path separator/);
			assert.throws(() => store.pathFor("a..b"), /\.\./);
			assert.throws(() => store.pathFor("/absolute"), /path separator/);

			const written = await store.write({ ...buildRecord(), id: "../escape" });
			assert.equal(written.ok, false);
			if (!written.ok) assert.match(written.error, /path separator/);
			assert.equal(existsSync(join(fixture.dir, "ignore/goals")), false);
		} finally {
			fixture.cleanup();
		}
	});
});

/** Write the record with one front-matter key removed. */
function rewriteWithoutKey(root: string, id: string, key: string): void {
	const path = join(root, "ignore/goals", `${id}.md`);
	const text = readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => !line.startsWith(`${key}:`))
		.join("\n");
	writeFileSync(path, text);
}
