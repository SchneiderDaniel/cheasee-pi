import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Metadata } from "./types.js";

/**
 * Create a symlink at `linkDir/linkName` pointing to `targetFile`.
 *
 * Uses a unique temp name (with random suffix) to avoid EEXIST races
 * between concurrent writers, then atomically renames tmp → target.
 *
 * If rename fails with ENOENT another concurrent writer won the race —
 * the target link already points to a valid symlink, so we clean up our
 * temp file and return silently. Non-ENOENT errors are rethrown.
 *
 * This is the single source of truth for atomic symlink creation — both
 * {@link ensureSymlink} and the background retry in {@link scheduleLinkRetry}
 * delegate to this helper to avoid code duplication.
 */
export async function createAtomicSymlink(
	linkDir: string,
	targetFile: string,
	linkName: string,
): Promise<void> {
	const latestLink = path.join(linkDir, linkName);
	const linkTarget = path.relative(linkDir, targetFile);
	const rand = crypto.randomBytes(4).toString("hex");
	const tmpLink = `${latestLink}.tmp.${rand}`;

	await fs.symlink(linkTarget, tmpLink);

	try {
		await fs.rename(tmpLink, latestLink);
	} catch (err: unknown) {
		const nodeErr = err as NodeJS.ErrnoException;
		if (nodeErr.code === "ENOENT") {
			// Another writer won the race — clean up our tmp and move on.
			try {
				await fs.unlink(tmpLink);
			} catch {
				// Ignore cleanup failures.
			}
		} else {
			throw err;
		}
	}
}

/**
 * Create or update a symlink at `linkDir/linkName` pointing to `targetFile`.
 *
 * Ensures the link directory exists, delegates to {@link createAtomicSymlink}
 * for atomic symlink creation, then schedules a background retry if
 * the target file doesn't exist yet (dangling symlink fix).
 */
export async function ensureSymlink(
	linkDir: string,
	targetFile: string,
	linkName: string,
): Promise<void> {
	// Ensure symlink directory exists.
	await fs.mkdir(linkDir, { recursive: true });

	await createAtomicSymlink(linkDir, targetFile, linkName);

	// Non-blocking: if target doesn't exist yet, schedule background retry
	// to fix dangling symlink when file appears.
	try {
		await fs.stat(targetFile);
	} catch {
		scheduleLinkRetry(linkDir, targetFile, linkName);
	}
}

// Background retry constants
const RETRY_INTERVAL = 200; // ms between retries
const MAX_RETRIES = 25; // ~5 seconds total

/**
 * Fire-and-forget background retry. Polls for target file to appear,
 * then re-creates symlink so it's no longer dangling.
 */
function scheduleLinkRetry(linkDir: string, targetFile: string, linkName: string): void {
	let retries = 0;

	function tick(): void {
		if (retries >= MAX_RETRIES) return;
		retries++;

		fs.stat(targetFile)
			.then(() => {
				// File exists — re-create symlink (now valid)
				createAtomicSymlink(linkDir, targetFile, linkName).catch(() => {});
			})
			.catch(() => {
				setTimeout(tick, RETRY_INTERVAL);
			});
	}

	setTimeout(tick, RETRY_INTERVAL);
}

/**
 * Write metadata JSON using sessionPrefix as filename prefix (same as JSONL basename).
 */
export async function writeMetadata(
	sessionDir: string,
	sessionPrefix: string,
	metadata: Metadata,
): Promise<void> {
	await fs.writeFile(
		path.join(sessionDir, `${sessionPrefix}.metadata.json`),
		JSON.stringify(metadata, null, 2),
	);
}

/**
 * Write markdown report using sessionPrefix as filename prefix.
 */
export async function writeSessionReport(
	sessionDir: string,
	sessionPrefix: string,
	markdown: string,
): Promise<void> {
	const mdPath = path.join(sessionDir, `${sessionPrefix}.md`);
	await fs.writeFile(mdPath, markdown, "utf-8");
}
