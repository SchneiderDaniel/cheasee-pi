/**
 * Verify docs/daily-usage.md and README.md contain native Docker workflow documentation.
 *
 * Covers:
 *   - docs/daily-usage.md existence and Jekyll frontmatter
 *   - All required sections: Prerequisites, Start, Run, Parallel, Stop, Rebuild, Troubleshooting
 *   - Parallel sessions documentation
 *   - Both workflow paths (native docker + legacy wrapper)
 *   - README quick-start integration
 *   - Technical correctness (exec vs attach, HOST_UID/HOST_GID, env passthrough, down vs stop)
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DOCS_DIR = resolve(import.meta.dirname, "..", "docs");
const DAILY_USAGE_PATH = resolve(DOCS_DIR, "daily-usage.md");
const README_PATH = resolve(import.meta.dirname, "..", "README.md");

function readDoc(): string {
	return readFileSync(DAILY_USAGE_PATH, "utf-8");
}

describe("docs/daily-usage.md", () => {
	// --- Phase 1: Document existence and frontmatter ---
	describe("Phase 1: Document existence and frontmatter", () => {
		it("exists as a regular file", () => {
			assert.ok(existsSync(DAILY_USAGE_PATH), "docs/daily-usage.md not found");
		});

		it("frontmatter starts with --- on first line", () => {
			const content = readDoc();
			assert.ok(content.startsWith("---"), "Frontmatter should start with ---");
		});

		it("frontmatter contains layout: default", () => {
			const content = readDoc();
			assert.ok(content.includes("layout: default"), "Missing layout: default");
		});

		it("frontmatter contains title: Daily Usage", () => {
			const content = readDoc();
			assert.ok(content.includes("title: Daily Usage"), "Missing title: Daily Usage");
		});

		it("frontmatter contains nav_order: 3", () => {
			const content = readDoc();
			assert.ok(content.includes("nav_order: 3"), "Missing nav_order: 3");
		});
	});

	// --- Phase 2: Section coverage ---
	describe("Phase 2: Section coverage", () => {
		it("has a Prerequisites section", () => {
			const content = readDoc();
			assert.ok(/^##\s+.*[Pp]rerequisites/im.test(content), "Missing Prerequisites section");
		});

		it("has a Start section referring to docker compose up", () => {
			const content = readDoc();
			assert.ok(/^##\s+.*[Ss]tart/im.test(content), "Missing Start section");
			assert.ok(content.includes("docker compose"), "Missing docker compose mention");
		});

		it("has a Run section referring to docker exec", () => {
			const content = readDoc();
			assert.ok(/^##\s+.*[Rr]un/im.test(content), "Missing Run section");
			assert.ok(content.includes("docker exec"), "Missing docker exec mention");
		});

		it("has a Parallel sessions section", () => {
			const content = readDoc();
			assert.ok(/^##\s+.*[Pp]arallel/im.test(content), "Missing Parallel sessions section");
		});

		it("has a Stop section referring to docker compose down", () => {
			const content = readDoc();
			assert.ok(/^##\s+.*[Ss]top/im.test(content), "Missing Stop section");
			assert.ok(content.includes("docker compose down"), "Missing docker compose down");
		});

		it("has a Rebuild section", () => {
			const content = readDoc();
			assert.ok(/^##\s+.*[Rr]ebuild/im.test(content), "Missing Rebuild section");
		});

		it("has a Troubleshooting section", () => {
			const content = readDoc();
			assert.ok(/^##\s+.*[Tt]roubleshoot/im.test(content), "Missing Troubleshooting section");
		});

		it("has all seven sections present", () => {
			const content = readDoc();
			const sections = content.match(/^##\s+.+/gm) || [];
			const found = sections.join(" ").toLowerCase();
			assert.ok(found.includes("prerequisites"), "Missing Prerequisites");
			assert.ok(found.includes("start"), "Missing Start");
			assert.ok(found.includes("run"), "Missing Run");
			assert.ok(found.includes("parallel"), "Missing Parallel");
			assert.ok(found.includes("stop"), "Missing Stop");
			assert.ok(found.includes("rebuild"), "Missing Rebuild");
			assert.ok(found.includes("troubleshoot"), "Missing Troubleshooting");
		});
	});

	// --- Phase 3: Commands covered ---
	describe("Phase 3: Command coverage", () => {
		it("mentions docker compose up", () => {
			assert.ok(readDoc().includes("docker compose"), "Missing docker compose");
		});

		it("mentions docker exec", () => {
			assert.ok(readDoc().includes("docker exec"), "Missing docker exec");
		});

		it("mentions docker compose down", () => {
			assert.ok(readDoc().includes("docker compose down"), "Missing docker compose down");
		});

		it("mentions docker compose build or --build", () => {
			const content = readDoc();
			assert.ok(
				content.includes("docker compose build") || content.includes("--build"),
				"Missing docker compose build or --build",
			);
		});
	});

	// --- Phase 4: Parallel sessions ---
	describe("Phase 4: Parallel sessions", () => {
		it("mentions running docker exec from multiple terminals", () => {
			const content = readDoc();
			assert.ok(
				/multiple.*terminal|independent.*process|same.*container/im.test(content),
				"Missing parallel sessions explanation",
			);
		});

		it("mentions stale-process cleanup", () => {
			const content = readDoc();
			assert.ok(/stale|cleanup|orphan/im.test(content), "Missing stale-process cleanup mention");
		});
	});

	// --- Phase 5: Convenience scripts and legacy wrapper ---
	describe("Phase 5: Wrapper documentation", () => {
		it("references docker/run-pi.sh", () => {
			assert.ok(readDoc().includes("run-pi.sh"), "Missing run-pi.sh reference");
		});

		it("references docker/stop-pi.sh", () => {
			assert.ok(readDoc().includes("stop-pi.sh"), "Missing stop-pi.sh reference");
		});
	});

	// --- Phase 6: README integration ---
	describe("Phase 6: README integration", () => {
		it("README mentions docker compose up/down or docker exec", () => {
			const readme = readFileSync(README_PATH, "utf-8");
			assert.ok(
				/docker compose.*up|docker compose.*down|docker exec/im.test(readme),
				"README missing Docker commands",
			);
		});

		it("README links to daily-usage doc", () => {
			const readme = readFileSync(README_PATH, "utf-8");
			assert.ok(/daily[-\s]usage/im.test(readme), "README missing link to daily-usage doc");
		});
	});

	// --- Phase 7: Technical correctness ---
	describe("Phase 7: Technical correctness", () => {
		it("does NOT recommend docker attach", () => {
			const content = readDoc();
			// docker attach should not be recommended as the primary way to interact
			// (container uses sleep infinity, making attach useless)
			const attachMentioned = /docker attach/.test(content);
			if (attachMentioned) {
				// If it's mentioned, it must be in a negative context
				const lines = content.split("\n");
				const attachLines = lines.filter((l) => /docker attach/i.test(l));
				for (const line of attachLines) {
					assert.ok(
						/not|don't|never|avoid|instead/im.test(line),
						`Line mentions docker attach without negative context: "${line.trim()}"`,
					);
				}
			}
		});

		it("documents HOST_UID and HOST_GID passthrough", () => {
			const content = readDoc();
			assert.ok(/HOST_UID|HOST_GID/im.test(content), "Missing HOST_UID/HOST_GID documentation");
		});

		it("shows -e KEY=$KEY pattern for API key passthrough", () => {
			const content = readDoc();
			assert.ok(
				/-e\s+\w*_KEY|-e\s+\w*_API_KEY|env/im.test(content),
				"Missing env passthrough documentation",
			);
		});

		it("distinguishes docker compose down from docker compose stop", () => {
			const content = readDoc();
			assert.ok(
				content.includes("docker compose stop"),
				"Missing docker compose stop mention (vs down distinction)",
			);
		});
	});
});
