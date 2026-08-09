/**
 * Verify docs/installation.md matches the repo-mount restructure (#1493).
 *
 * Covers:
 *   - Phase 1: Document existence and Jekyll frontmatter
 *   - Phase 2: Single install path (CLI binary; no fork/clone, no legacy bash)
 *   - Phase 3: Install content completeness (download, OS detection, setup)
 *   - Phase 4: Legacy bash path fully removed (per #1493 AC)
 *   - Phase 5: README quick-start integration
 *   - Phase 6: Cross-reference correctness
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DOCS_DIR = resolve(import.meta.dirname, "..", "docs");
const INSTALL_PATH = resolve(DOCS_DIR, "installation.md");
const README_PATH = resolve(import.meta.dirname, "..", "README.md");

function readDoc(): string {
	return readFileSync(INSTALL_PATH, "utf-8");
}

function readReadme(): string {
	return readFileSync(README_PATH, "utf-8");
}

function sectionIndex(content: string, heading: string): number {
	const match = content.match(new RegExp(`##\\s+${heading}`, "im"));
	return match ? (match.index ?? -1) : -1;
}

/** Extract content between two headings (start inclusive, end exclusive). */
function sectionContent(content: string, startHeading: string, endHeading: string): string | null {
	const startMatch = content.match(new RegExp(`##\\s+${startHeading}`, "im"));
	if (!startMatch) return null;
	const startIdx = startMatch.index!;
	const afterStart = content.slice(startIdx);

	const endMatch = afterStart.match(new RegExp(`\\n##\\s+${endHeading}`, "im"));
	if (!endMatch) return afterStart; // no end marker -> rest of document

	return afterStart.slice(0, endMatch.index!);
}

describe("docs/installation.md", () => {
	// --- Phase 1: Document structure and frontmatter ---
	describe("Phase 1: Document structure and frontmatter", () => {
		it("exists as a regular file", () => {
			assert.ok(existsSync(INSTALL_PATH), "docs/installation.md not found");
		});

		it("frontmatter starts with --- on first line", () => {
			const content = readDoc();
			assert.ok(content.startsWith("---"), "Frontmatter should start with ---");
		});

		it("frontmatter contains layout: default", () => {
			const content = readDoc();
			assert.ok(content.includes("layout: default"), "Missing layout: default");
		});

		it("frontmatter contains title: Installation", () => {
			const content = readDoc();
			assert.ok(content.includes("title: Installation"), "Missing title: Installation");
		});

		it("frontmatter contains nav_order: 2", () => {
			const content = readDoc();
			assert.ok(content.includes("nav_order: 2"), "Missing nav_order: 2");
		});

		it("document has Table of contents or {:toc} reference", () => {
			const content = readDoc();
			assert.ok(
				/##\s+Table\s+of\s+contents|{:toc}/im.test(content),
				"Missing Table of contents or {:toc}",
			);
		});
	});

	// --- Phase 2: Single install path (#1493 restructure) ---
	describe("Phase 2: Single CLI install path", () => {
		it("has an Install section", () => {
			const content = readDoc();
			assert.ok(/^##\s+Install/im.test(content), "Missing Install section");
		});

		it("Install section starts with a binary download (tar.gz / GitHub Releases)", () => {
			const content = readDoc();
			const installSection = sectionContent(content, "Install", "Verify");
			assert.ok(installSection, "Install section not found");
			assert.ok(
				/download|tar\.gz|GitHub Releases/im.test(installSection),
				"Install section missing binary download step",
			);
		});

		it("does NOT reference a Legacy Bash Path section (removed in #1493)", () => {
			const content = readDoc();
			assert.ok(
				!/##\s+Legacy\s+[Bb]ash\s+Path/im.test(content),
				"Legacy Bash Path section must be removed (#1493)",
			);
		});

		it("has a Setup section using cheasee-pi init", () => {
			const content = readDoc();
			const setupSection = sectionContent(content, "Setup", "Run");
			assert.ok(setupSection, "Setup section not found");
			assert.ok(
				setupSection.includes("cheasee-pi init"),
				"Setup section missing 'cheasee-pi init'",
			);
		});

		it("Setup section states no fork/clone (user's own repo is used)", () => {
			const content = readDoc();
			const setupSection = sectionContent(content, "Setup", "Run");
			assert.ok(setupSection, "Setup section not found");
			assert.ok(
				/no\s+fork|no\s+clone|not.*clone/im.test(setupSection),
				"Setup section must state no fork/clone happens",
			);
		});

		it("Run section requires the user's own git repository", () => {
			const content = readDoc();
			const runSection = sectionContent(content, "Run", "After setup");
			assert.ok(runSection, "Run section not found");
			assert.ok(
				/git\s+repositor|git\s+repo/im.test(runSection),
				"Run section missing git repository requirement",
			);
		});

		it("Run section mentions the CLI cache dir for compose/Dockerfile", () => {
			const content = readDoc();
			const runSection = sectionContent(content, "Run", "After setup");
			assert.ok(runSection, "Run section not found");
			assert.ok(
				/cache|~\/\.cache\/cheasee-pi/im.test(runSection),
				"Run section missing CLI cache dir mention",
			);
		});

		it("Run section mentions /workspaces/main mount", () => {
			const content = readDoc();
			const runSection = sectionContent(content, "Run", "After setup");
			assert.ok(runSection, "Run section not found");
			assert.ok(
				runSection.includes("/workspaces/main"),
				"Run section missing /workspaces/main mount",
			);
		});
	});

	// --- Phase 3: Install content completeness ---
	describe("Phase 3: Install content completeness", () => {
		const getInstallSection = (): string => {
			const content = readDoc();
			const section = sectionContent(content, "Install", "Verify");
			assert.ok(section, "Install section not found");
			return section;
		};

		it("includes architecture/OS detection snippet (uname)", () => {
			const section = getInstallSection();
			assert.ok(/uname/im.test(section), "Install section missing uname architecture detection");
		});

		it("includes macOS-specific xattr -d com.apple.quarantine instruction", () => {
			const section = getInstallSection();
			assert.ok(section.includes("xattr"), "Install section missing xattr Gatekeeper bypass");
		});

		it("includes Windows install guidance", () => {
			const section = getInstallSection();
			assert.ok(/Windows/i.test(section), "Install section missing Windows guidance");
		});

		it("includes a Verify step (cheasee-pi --version)", () => {
			const content = readDoc();
			const verifySection = sectionContent(content, "Verify", "Setup");
			assert.ok(verifySection, "Verify section not found");
			assert.ok(verifySection.includes("--version"), "Verify section missing cheasee-pi --version");
		});

		it("Prerequisites include Docker", () => {
			const content = readDoc();
			const prereqSection = sectionContent(content, "Prerequisites", "Install");
			assert.ok(prereqSection, "Prerequisites section not found");
			assert.ok(/Docker/im.test(prereqSection), "Prerequisites section missing Docker");
		});

		it("Prerequisites include git", () => {
			const content = readDoc();
			const prereqSection = sectionContent(content, "Prerequisites", "Install");
			assert.ok(prereqSection, "Prerequisites section not found");
			assert.ok(/git/im.test(prereqSection), "Prerequisites section missing git");
		});

		it("After-setup section covers .pi/settings.json configuration", () => {
			const content = readDoc();
			const afterSection = sectionContent(content, "After setup", "What's next");
			assert.ok(afterSection, "After setup section not found");
			assert.ok(
				/settings\.json/im.test(afterSection),
				"After setup section missing settings.json configuration",
			);
		});
	});

	// --- Phase 4: Legacy bash path removed (#1493) ---
	describe("Phase 4: Legacy bash path removed", () => {
		it("does NOT reference run-pi.sh", () => {
			const content = readDoc();
			assert.ok(!content.includes("run-pi.sh"), "Legacy run-pi.sh must not be referenced (#1493)");
		});

		it("does NOT reference stop-pi.sh", () => {
			const content = readDoc();
			assert.ok(
				!content.includes("stop-pi.sh"),
				"Legacy stop-pi.sh must not be referenced (#1493)",
			);
		});

		it("does NOT reference cheasee-pi.sh wrapper", () => {
			const content = readDoc();
			assert.ok(
				!content.includes("cheasee-pi.sh"),
				"Legacy cheasee-pi.sh wrapper must not be referenced (#1493)",
			);
		});

		it("does NOT reference git clone --bare workflow", () => {
			const content = readDoc();
			assert.ok(
				!content.includes("--bare"),
				"Legacy git clone --bare workflow must not be referenced (#1493)",
			);
		});

		it("does NOT reference git worktree add", () => {
			const content = readDoc();
			assert.ok(
				!/worktree\s+add/im.test(content),
				"Legacy git worktree add must not be referenced (#1493)",
			);
		});
	});

	// --- Phase 5: README quick-start integration ---
	describe("Phase 5: README quick-start integration", () => {
		it("README contains a link or reference to installation.md", () => {
			const readme = readReadme();
			assert.ok(
				/installation\.md|installation/im.test(readme),
				"README missing reference to installation doc",
			);
		});

		it("README quick-start mentions cheasee-pi init", () => {
			const readme = readReadme();
			assert.ok(
				/cheasee-pi\s+init|Go\s+CLI|Recommended/im.test(readme),
				"README quick-start missing cheasee-pi init mention",
			);
		});

		it("README quick-start still references docker compose workflow", () => {
			const readme = readReadme();
			assert.ok(
				/docker compose/im.test(readme),
				"README missing docker compose workflow reference",
			);
		});

		it("README documentation table still lists Installation section", () => {
			const readme = readReadme();
			assert.ok(
				/Installation|installation/im.test(readme),
				"README missing Installation in documentation table",
			);
		});
	});

	// --- Phase 6: Cross-reference correctness ---
	describe("Phase 6: Cross-reference correctness", () => {
		it("ends with a handoff/reference to daily-usage.md for post-setup workflow", () => {
			const content = readDoc();
			assert.ok(/daily-usage|daily usage/im.test(content), "Missing handoff to daily-usage.md");
		});

		it("has a Troubleshooting section", () => {
			const content = readDoc();
			assert.ok(/^##\s+.*[Tt]roubleshoot/im.test(content), "Missing Troubleshooting section");
		});

		it("has a Prerequisites section", () => {
			const content = readDoc();
			assert.ok(/^##\s+.*[Pp]rerequisites/im.test(content), "Missing Prerequisites section");
		});

		it("all internal anchor references (#) resolve to section headings in the same file", () => {
			const content = readDoc();
			// Find all markdown anchor links like [text](#some-slug)
			const anchorRegex = /\[([^\]]+)\]\(#([^)]+)\)/g;
			const anchors: string[] = [];
			let match;
			while ((match = anchorRegex.exec(content)) !== null) {
				anchors.push(match[2]);
			}

			// Find all section headings and build standard GitHub-style slugs
			// GitHub/Jekyll: lowercase, replace [^a-z0-9]+ with -, trim leading/trailing -
			const headingRegex = /^#{1,6}\s+(.+)$/gm;
			const existingSlugs = new Set<string>();
			let hMatch;
			while ((hMatch = headingRegex.exec(content)) !== null) {
				const slug = hMatch[1]
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "");
				existingSlugs.add(slug);
			}

			const brokenAnchors = anchors.filter((a) => !existingSlugs.has(a));
			assert.ok(
				brokenAnchors.length === 0,
				`Broken internal anchor(s): ${brokenAnchors.join(", ")}`,
			);
		});
	});
});
