/**
 * Verify docs/installation.md covers both Go CLI and legacy bash install paths.
 *
 * Covers:
 *   - Phase 1: Document existence and Jekyll frontmatter
 *   - Phase 2: Both install paths present (Go CLI first, legacy second)
 *   - Phase 3: Go CLI path content completeness
 *   - Phase 4: Legacy bash path preservation (unchanged per AC2)
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
	return match ? match.index ?? -1 : -1;
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
				"Missing Table of contents or {:toc}"
			);
		});
	});

	// --- Phase 2: Both install paths present ---
	describe("Phase 2: Both install paths present", () => {
		it("has a Go CLI Path section heading", () => {
			const content = readDoc();
			assert.ok(
				/##\s+Go\s+CLI\s+Path/im.test(content),
				"Missing Go CLI Path section"
			);
		});

		it("Go CLI path section is before Legacy Bash Path section", () => {
			const content = readDoc();
			const goIdx = sectionIndex(content, "Go\\s+CLI\\s+Path");
			const legacyIdx = sectionIndex(content, "Legacy\\s+[Bb]ash\\s+Path");
			assert.ok(goIdx >= 0, "Go CLI Path section not found");
			assert.ok(legacyIdx >= 0, "Legacy Bash Path section not found");
			assert.ok(goIdx < legacyIdx, "Go CLI Path must come before Legacy Bash Path");
		});

		it("Go CLI path heading or adjacent callout contains Recommended marker", () => {
			const content = readDoc();
			const match = content.match(/##\s+Go\s+CLI\s+Path[\s\S]*?(?=\n##|\n---)/m);
			assert.ok(match, "Go CLI Path section not found");
			assert.ok(
				/\*\*Recommended\*\*|\*Recommended\*|Recommended/im.test(match[0]),
				"Go CLI Path section missing 'Recommended' marker"
			);
		});

		it("has a Legacy Bash Path section heading", () => {
			const content = readDoc();
			assert.ok(
				/##\s+Legacy\s+[Bb]ash\s+Path/im.test(content),
				"Missing Legacy Bash Path section"
			);
		});

		it("Go CLI path mentions cheasee-pi init", () => {
			const content = readDoc();
			const goSection = sectionContent(content, "Go\\s+CLI\\s+Path", "Legacy\\s+[Bb]ash\\s+Path");
			assert.ok(goSection, "Go CLI Path section content not found");
			assert.ok(
				goSection.includes("cheasee-pi init"),
				"Go CLI path missing 'cheasee-pi init'"
			);
		});

		it("Go CLI path mentions cheasee-pi start", () => {
			const content = readDoc();
			const goSection = sectionContent(content, "Go\\s+CLI\\s+Path", "Legacy\\s+[Bb]ash\\s+Path");
			assert.ok(goSection, "Go CLI Path section content not found");
			assert.ok(
				goSection.includes("cheasee-pi start"),
				"Go CLI path missing 'cheasee-pi start'"
			);
		});
	});

	// --- Phase 3: Go CLI path content completeness ---
	describe("Phase 3: Go CLI path content completeness", () => {
		const getGoSection = (): string => {
			const content = readDoc();
			const section = sectionContent(content, "Go\\s+CLI\\s+Path", "Legacy\\s+[Bb]ash\\s+Path");
			assert.ok(section, "Go CLI Path section not found");
			return section;
		};

		it("includes a Download Binary step referencing GitHub Releases or tar.gz", () => {
			const section = getGoSection();
			assert.ok(
				/download|tar\.gz|GitHub Releases/im.test(section),
				"Go CLI path missing Download Binary step"
			);
		});

		it("includes architecture/OS detection snippet (uname)", () => {
			const section = getGoSection();
			assert.ok(
				/uname/im.test(section),
				"Go CLI path missing uname architecture detection"
			);
		});

		it("includes macOS-specific xattr -d com.apple.quarantine instruction", () => {
			const section = getGoSection();
			assert.ok(
				section.includes("xattr"),
				"Go CLI path missing xattr Gatekeeper bypass"
			);
		});

		it("includes chmod +x instruction", () => {
			const section = getGoSection();
			assert.ok(
				section.includes("chmod +x") || section.includes("chmod a+x"),
				"Go CLI path missing chmod +x instruction"
			);
		});

		it("includes a Verify Docker or Install Docker prerequisite step", () => {
			const section = getGoSection();
			assert.ok(
				/Docker/im.test(section),
				"Go CLI path missing Docker prerequisite"
			);
		});

		it("includes a docker compose up step", () => {
			const section = getGoSection();
			assert.ok(
				/docker compose.*up/im.test(section),
				"Go CLI path missing docker compose up"
			);
		});

		it("includes a docker exec or pi command to enter the container", () => {
			const section = getGoSection();
			assert.ok(
				/docker exec|pi\b/im.test(section),
				"Go CLI path missing docker exec or pi command"
			);
		});

		it("includes a step to configure .pi/settings.json", () => {
			const section = getGoSection();
			assert.ok(
				/settings\.json/im.test(section),
				"Go CLI path missing settings.json configuration"
			);
		});

		it("mentions SHA256 checksum verification or checksums.txt", () => {
			const section = getGoSection();
			assert.ok(
				/checksum|sha256|checksums\.txt/im.test(section),
				"Go CLI path missing checksum verification"
			);
		});

		it("lists supported OS/arch matrix (linux/darwin × amd64/arm64)", () => {
			const section = getGoSection();
			assert.ok(
				/linux.*darwin|amd64.*arm64|linux.*amd64.*arm64/im.test(section),
				"Go CLI path missing supported OS/arch matrix"
			);
		});

		it("notes Windows users must use legacy path via WSL2", () => {
			const section = getGoSection();
			assert.ok(
				/Windows/i.test(section),
				"Go CLI path missing Windows guidance note"
			);
		});

		it("states bandwidth advantage (~15-30MB binary vs ~500MB clone)", () => {
			const section = getGoSection();
			assert.ok(
				/\d+\s*MB/im.test(section),
				"Go CLI path missing bandwidth comparison"
			);
		});
	});

	// --- Phase 4: Legacy bash path preservation ---
	describe("Phase 4: Legacy bash path preservation", () => {
		const getLegacySection = (): string => {
			const content = readDoc();
			const section = sectionContent(content, "Legacy\\s+[Bb]ash\\s+Path", "IDE|What happens|Verification|Troubleshooting");
			assert.ok(section, "Legacy Bash Path section not found");
			return section;
		};

		it("contains 8 original steps: Docker, git/gh, fork, worktree, submodule, start, API key, settings", () => {
			const section = getLegacySection().toLowerCase();
			const stepMatches = section.match(/###\s+step\s+\d+/gi) || [];
			assert.ok(stepMatches.length >= 7, `Expected at least 7 steps, found ${stepMatches.length}`);
		});

		it("mentions ./cheasee-pi.sh wrapper", () => {
			const section = getLegacySection();
			assert.ok(
				section.includes("cheasee-pi.sh"),
				"Legacy path missing cheasee-pi.sh reference"
			);
		});

		it("references git clone --bare workflow", () => {
			const section = getLegacySection();
			assert.ok(
				section.includes("--bare"),
				"Legacy path missing git clone --bare"
			);
		});

		it("references git worktree add", () => {
			const section = getLegacySection();
			assert.ok(
				/worktree\s+add/im.test(section),
				"Legacy path missing git worktree add"
			);
		});

		it("references git submodule configuration", () => {
			const section = getLegacySection();
			assert.ok(
				/submodule/im.test(section),
				"Legacy path missing git submodule"
			);
		});

		it("does NOT reference cheasee-pi init (per AC2 unchanged)", () => {
			const section = getLegacySection();
			assert.ok(
				!section.includes("cheasee-pi init"),
				"Legacy path must NOT reference cheasee-pi init"
			);
		});

		it("mentions gh auth login -s repo,project,workflow", () => {
			const section = getLegacySection();
			assert.ok(
				/gh\s+auth\s+login/im.test(section),
				"Legacy path missing gh auth login"
			);
		});
	});

	// --- Phase 5: README quick-start integration ---
	describe("Phase 5: README quick-start integration", () => {
		it("README contains a link or reference to installation.md", () => {
			const readme = readReadme();
			assert.ok(
				/installation\.md|installation/im.test(readme),
				"README missing reference to installation doc"
			);
		});

		it("README quick-start mentions Go CLI path or cheasee-pi init", () => {
			const readme = readReadme();
			assert.ok(
				/cheasee-pi\s+init|Go\s+CLI|Recommended/im.test(readme),
				"README quick-start missing Go CLI path mention"
			);
		});

		it("README quick-start still references docker compose workflow", () => {
			const readme = readReadme();
			assert.ok(
				/docker compose/im.test(readme),
				"README missing docker compose workflow reference"
			);
		});

		it("README documentation table still lists Installation section", () => {
			const readme = readReadme();
			assert.ok(
				/Installation|installation/im.test(readme),
				"README missing Installation in documentation table"
			);
		});
	});

	// --- Phase 6: Cross-reference correctness ---
	describe("Phase 6: Cross-reference correctness", () => {
		it("ends with a handoff/reference to daily-usage.md for post-setup workflow", () => {
			const content = readDoc();
			assert.ok(
				/daily-usage|daily usage/im.test(content),
				"Missing handoff to daily-usage.md"
			);
		});

		it("has a Troubleshooting section", () => {
			const content = readDoc();
			assert.ok(
				/^##\s+.*[Tt]roubleshoot/im.test(content),
				"Missing Troubleshooting section"
			);
		});

		it("has a Prerequisites section", () => {
			const content = readDoc();
			assert.ok(
				/^##\s+.*[Pp]rerequisites/im.test(content),
				"Missing Prerequisites section"
			);
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

			const brokenAnchors = anchors.filter(a => !existingSlugs.has(a));
			assert.ok(
				brokenAnchors.length === 0,
				`Broken internal anchor(s): ${brokenAnchors.join(", ")}`
			);
		});
	});
});
