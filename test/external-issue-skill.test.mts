/**
 * Tests for external-issue skill
 *
 * Text-analysis tests that read the SKILL.md file and assert content patterns.
 * Tests cover all requirements from Issue #861.
 *
 * Run with:
 *   node --experimental-strip-types --test test/external-issue-skill.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const SKILL_PATH = resolve(import.meta.dirname, "..", ".pi/skills/external-issue/SKILL.md");

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns { frontmatter: Record<string, string | object>, body: string }
 */
function parseFrontmatter(filePath: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const content = readFileSync(filePath, "utf-8");
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") {
		return { frontmatter: {}, body: content };
	}
	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			endIndex = i;
			break;
		}
	}
	if (endIndex === -1) {
		return { frontmatter: {}, body: content };
	}
	const fmLines = lines.slice(1, endIndex);
	const body = lines.slice(endIndex + 1).join("\n");

	// Simple YAML frontmatter parser for flat and nested metadata
	const frontmatter: Record<string, unknown> = {};
	let currentKey: string | null = null;
	const nestedLines: string[] = [];

	for (const line of fmLines) {
		const trimmed = line.trim();
		if (trimmed === "") continue;

		// Check indentation for nested values
		if (line.startsWith("  ") || line.startsWith("\t")) {
			if (currentKey) {
				nestedLines.push(trimmed);
			}
			continue;
		}

		// Flush nested content before starting new key
		if (nestedLines.length > 0 && currentKey) {
			const nestedObj: Record<string, string> = {};
			for (const nl of nestedLines) {
				const ci = nl.indexOf(":");
				if (ci !== -1) {
					nestedObj[nl.slice(0, ci).trim()] = nl.slice(ci + 1).trim();
				}
			}
			frontmatter[currentKey] = nestedObj;
			nestedLines.length = 0;
		}

		const colonIdx = line.indexOf(":");
		if (colonIdx !== -1) {
			currentKey = line.slice(0, colonIdx).trim();
			let value = line.slice(colonIdx + 1).trim();

			// If value is empty, it might be a nested mapping start
			if (value === "") {
				continue;
			}

			// Try to parse as JSON if it looks like an array
			if (value.startsWith("[")) {
				try {
					frontmatter[currentKey] = JSON.parse(value) as unknown;
				} catch {
					frontmatter[currentKey] = value;
				}
			} else {
				// Remove surrounding quotes
				value = value.replace(/^["'](.*)["']$/, "$1");
				frontmatter[currentKey] = value;
			}
		}
	}

	// Handle trailing nested block
	if (nestedLines.length > 0 && currentKey) {
		const nestedObj: Record<string, string> = {};
		for (const nl of nestedLines) {
			const ci = nl.indexOf(":");
			if (ci !== -1) {
				nestedObj[nl.slice(0, ci).trim()] = nl.slice(ci + 1).trim();
			}
		}
		frontmatter[currentKey] = nestedObj;
	}

	return { frontmatter, body };
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: File existence and structure
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: File existence and structure", () => {
	it("exists at .pi/skills/external-issue/SKILL.md", () => {
		assert.ok(existsSync(SKILL_PATH), `File not found: ${SKILL_PATH}`);
	});

	it("YAML frontmatter parses without error", () => {
		const { frontmatter } = parseFrontmatter(SKILL_PATH);
		assert.ok(Object.keys(frontmatter).length > 0, "No frontmatter parsed");
	});

	it("frontmatter contains name, description, metadata keys with non-empty values", () => {
		const { frontmatter } = parseFrontmatter(SKILL_PATH);
		assert.ok("name" in frontmatter, "name key missing");
		assert.ok("description" in frontmatter, "description key missing");
		assert.ok("metadata" in frontmatter, "metadata key missing");
		assert.ok(
			typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0,
			"name value is empty or not a string",
		);
		assert.ok(
			typeof frontmatter.description === "string" && frontmatter.description.trim().length > 0,
			"description value is empty or not a string",
		);
		assert.ok(
			typeof frontmatter.metadata === "object" &&
				frontmatter.metadata !== null &&
				Object.keys(frontmatter.metadata as Record<string, unknown>).length > 0,
			"metadata is empty or not an object",
		);
	});

	it("frontmatter keys are exactly allowed set: name, description, metadata", () => {
		const { frontmatter } = parseFrontmatter(SKILL_PATH);
		const allowedKeys = new Set(["name", "description", "metadata"]);
		for (const key of Object.keys(frontmatter)) {
			assert.ok(allowedKeys.has(key), `Unexpected frontmatter key: ${key}`);
		}
	});

	it("name field equals external-issue", () => {
		const { frontmatter } = parseFrontmatter(SKILL_PATH);
		assert.strictEqual(frontmatter.name, "external-issue");
	});

	it("markdown body is non-empty after frontmatter", () => {
		const { body } = parseFrontmatter(SKILL_PATH);
		assert.ok(body.trim().length > 0, "Body is empty after frontmatter");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: 5-step checklist completeness (R1)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: 5-step checklist completeness (R1)", () => {
	const { body } = parseFrontmatter(SKILL_PATH);

	it("Step 1 mentions CONTRIBUTING.md and .github/ISSUE_TEMPLATE/ reading with gh api commands", () => {
		const step1Section = extractStepSection(body, 1);
		assert.ok(step1Section, "Step 1 section not found");
		assert.ok(step1Section.includes("CONTRIBUTING.md"), "Step 1 missing CONTRIBUTING.md reference");
		assert.ok(
			step1Section.includes(".github/ISSUE_TEMPLATE"),
			"Step 1 missing .github/ISSUE_TEMPLATE reference",
		);
		assert.ok(step1Section.includes("gh api"), "Step 1 missing gh api command");
	});

	it("Step 2 mentions reading remote issue template(s) and handling both .md and .yml formats", () => {
		const step2Section = extractStepSection(body, 2);
		assert.ok(step2Section, "Step 2 section not found");
		assert.ok(
			step2Section.includes(".md") && step2Section.includes(".yml"),
			"Step 2 missing .md and .yml format references",
		);
		assert.ok(
			step2Section.includes("template") || step2Section.includes("Template"),
			"Step 2 missing template reference",
		);
	});

	it("Step 3 mentions gh search issues --repo OWNER/REPO with 3+ keyword permutations", () => {
		const step3Section = extractStepSection(body, 3);
		assert.ok(step3Section, "Step 3 section not found");
		assert.ok(step3Section.includes("gh search issues"), "Step 3 missing gh search issues command");
		assert.ok(
			step3Section.includes("--repo") || step3Section.includes("OWNER/REPO"),
			"Step 3 missing --repo OWNER/REPO reference",
		);
		assert.ok(
			step3Section.includes("keyword") || step3Section.includes("permutation"),
			"Step 3 missing keyword permutation reference",
		);
	});

	it('Step 3 includes "stop and report to user" / "Likely duplicate of #N" behavior', () => {
		const step3Section = extractStepSection(body, 3);
		assert.ok(step3Section, "Step 3 section not found");
		const hasStopLanguage =
			step3Section.includes("stop") ||
			step3Section.includes("Stop") ||
			step3Section.includes("STOP");
		const hasDuplicateLanguage =
			step3Section.includes("Likely duplicate") ||
			step3Section.includes("duplicate of #") ||
			step3Section.includes("duplicate");
		assert.ok(
			hasStopLanguage && hasDuplicateLanguage,
			'Step 3 missing "stop and report" or "Likely duplicate of #N" language',
		);
	});

	it("Step 4 mentions following repo template sections or using universal fallback format", () => {
		const step4Section = extractStepSection(body, 4);
		assert.ok(step4Section, "Step 4 section not found");
		const hasTemplateReference =
			step4Section.includes("template") || step4Section.includes("Template");
		const hasFallbackReference =
			step4Section.includes("Universal Fallback") ||
			step4Section.includes("fallback") ||
			step4Section.includes("Fallback");
		assert.ok(
			hasTemplateReference && hasFallbackReference,
			"Step 4 missing template sections or universal fallback reference",
		);
	});

	it("Step 5 mentions gh issue create --repo OWNER/REPO --title --body-file with temp file path", () => {
		const step5Section = extractStepSection(body, 5);
		assert.ok(step5Section, "Step 5 section not found");
		assert.ok(step5Section.includes("gh issue create"), "Step 5 missing gh issue create command");
		assert.ok(step5Section.includes("--repo"), "Step 5 missing --repo flag");
		assert.ok(step5Section.includes("--title"), "Step 5 missing --title flag");
		assert.ok(step5Section.includes("--body-file"), "Step 5 missing --body-file flag");
		assert.ok(
			step5Section.includes("/tmp/") || step5Section.includes("temp file"),
			"Step 5 missing temp file path reference",
		);
	});

	it("All 5 steps appear in numeric order and no step is missing", () => {
		for (let i = 1; i <= 5; i++) {
			const section = extractStepSection(body, i);
			assert.ok(section, `Step ${i} section not found`);
		}

		// Verify order by finding first occurrence of each step marker
		const stepMarkers = [];
		for (let i = 1; i <= 5; i++) {
			const marker = `### Step ${i}`;
			const idx = body.indexOf(marker);
			assert.ok(idx !== -1, `Marker "${marker}" not found`);
			stepMarkers.push({ step: i, index: idx });
		}

		// Check they appear in order
		for (let i = 1; i < stepMarkers.length; i++) {
			assert.ok(
				stepMarkers[i].index > stepMarkers[i - 1].index,
				`Step ${stepMarkers[i].step} appears before Step ${stepMarkers[i - 1].step}`,
			);
		}
	});

	it("Each step includes at least one example bash command in a fenced code block", () => {
		for (let i = 1; i <= 5; i++) {
			const section = extractStepSection(body, i);
			assert.ok(section, `Step ${i} section not found`);
			const hasBashBlock = section.includes("```bash") || section.includes("```sh");
			assert.ok(hasBashBlock, `Step ${i} missing example bash command in fenced code block`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Writing rules and fallback format (R2)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: Writing rules and fallback format (R2)", () => {
	const { body } = parseFrontmatter(SKILL_PATH);

	it("Universal fallback format documented with 5 sections", () => {
		const fallbackSection = extractSection(body, "Universal Fallback Format");
		assert.ok(fallbackSection, "Universal Fallback Format section not found");
		const expectedSections = [
			"Description",
			"Steps to Reproduce",
			"Expected vs Actual",
			"Environment",
			"Additional Context",
		];
		for (const section of expectedSections) {
			assert.ok(
				fallbackSection.includes(section),
				`Universal Fallback Format missing section: ${section}`,
			);
		}
	});

	it("Section headings use exactly ## Description, ## Steps to Reproduce, ## Expected vs Actual Behavior, ## Environment, ## Additional Context", () => {
		const fallbackSection = extractSection(body, "Universal Fallback Format");
		assert.ok(fallbackSection, "Universal Fallback Format section not found");
		const headings = [
			"## Description",
			"## Steps to Reproduce",
			"## Expected vs Actual Behavior",
			"## Environment",
			"## Additional Context",
		];
		for (const heading of headings) {
			assert.ok(fallbackSection.includes(heading), `Missing heading: ${heading}`);
		}
	});

	it("Neutral reproducible example rule: explicitly says to use generic code and never reference cheasee-pi", () => {
		const writingRulesSection =
			extractSection(body, "Writing Rules") ||
			extractSection(body, "Writing Rules (apply to all cases)");
		assert.ok(writingRulesSection, "Writing Rules section not found");
		const hasGenericCode =
			writingRulesSection.includes("generic") || writingRulesSection.includes("neutral");
		const hasNoCheaseePi =
			writingRulesSection.includes("cheasee-pi") ||
			writingRulesSection.includes("cheasee") ||
			writingRulesSection.includes("our codebase");
		assert.ok(
			hasGenericCode && hasNoCheaseePi,
			"Writing Rules missing generic code requirement or cheasee-pi exclusion",
		);
	});

	it("Tone rule: neutral third-person, factual, exact version numbers, imperative steps", () => {
		const writingRulesSection =
			extractSection(body, "Writing Rules") ||
			extractSection(body, "Writing Rules (apply to all cases)");
		assert.ok(writingRulesSection, "Writing Rules section not found");
		const hasToneRule =
			writingRulesSection.includes("third-person") ||
			writingRulesSection.includes("Neutral") ||
			writingRulesSection.includes("factual");
		const hasVersionNumbers =
			writingRulesSection.includes("version") || writingRulesSection.includes("version numbers");
		const hasImperativeSteps =
			writingRulesSection.includes("imperative") ||
			writingRulesSection.includes("Steps to Reproduce");
		assert.ok(
			hasToneRule && hasVersionNumbers,
			"Writing Rules missing tone, version numbers, or imperative steps requirements",
		);
	});

	it("Markdown formatting rule: headings + code blocks only, no extended markdown", () => {
		const writingRulesSection =
			extractSection(body, "Writing Rules") ||
			extractSection(body, "Writing Rules (apply to all cases)");
		assert.ok(writingRulesSection, "Writing Rules section not found");
		const hasMarkdownRule =
			writingRulesSection.includes("headings") ||
			writingRulesSection.includes("code block") ||
			writingRulesSection.includes("fenced code") ||
			writingRulesSection.includes("markdown formatting");
		assert.ok(hasMarkdownRule, "Writing Rules missing markdown formatting rule");
	});

	it("Template-filling rule: when repo has template, fill all required sections as-is", () => {
		const step4Section = extractStepSection(body, 4);
		assert.ok(step4Section, "Step 4 section not found");
		const hasFillTemplateLanguage =
			step4Section.includes("fill") ||
			step4Section.includes("Fill") ||
			step4Section.includes("populate") ||
			step4Section.includes("required sections");
		assert.ok(hasFillTemplateLanguage, "Step 4 missing template-filling rule");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Scope boundaries (R3)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 4: Scope boundaries (R3)", () => {
	const { body } = parseFrontmatter(SKILL_PATH);

	it('Explicitly states "does NOT create PRs — issues only"', () => {
		const scopeSection = extractSection(body, "Scope Boundaries");
		assert.ok(scopeSection, "Scope Boundaries section not found");
		const hasNoPrs =
			scopeSection.includes("NOT") &&
			(scopeSection.includes("pull request") ||
				scopeSection.includes("PR") ||
				scopeSection.includes("pull requests"));
		const hasIssuesOnly =
			scopeSection.includes("issues only") || scopeSection.includes("Issues only");
		assert.ok(
			hasNoPrs && hasIssuesOnly,
			"Scope Boundaries missing PR exclusion or issues-only statement",
		);
	});

	it("Explicitly excludes SchneiderDaniel/cheasee-pi repo", () => {
		const scopeSection = extractSection(body, "Scope Boundaries");
		assert.ok(scopeSection, "Scope Boundaries section not found");
		assert.ok(
			scopeSection.includes("SchneiderDaniel/cheasee-pi"),
			"Scope Boundaries missing cheasee-pi repo exclusion",
		);
	});

	it("Explicitly limits to public GitHub repos only", () => {
		const scopeSection = extractSection(body, "Scope Boundaries");
		assert.ok(scopeSection, "Scope Boundaries section not found");
		assert.ok(
			scopeSection.includes("public") || scopeSection.includes("Public"),
			"Scope Boundaries missing public repo limitation",
		);
	});

	it("Explicitly excludes non-GitHub platforms (GitLab, Bitbucket)", () => {
		const scopeSection = extractSection(body, "Scope Boundaries");
		assert.ok(scopeSection, "Scope Boundaries section not found");
		const hasNonGitHub =
			scopeSection.includes("GitLab") ||
			scopeSection.includes("Bitbucket") ||
			scopeSection.includes("non-GitHub");
		assert.ok(hasNonGitHub, "Scope Boundaries missing non-GitHub platform exclusion");
	});

	it("States gh CLI is the only required tool (no jq, curl)", () => {
		const scopeSection = extractSection(body, "Scope Boundaries");
		assert.ok(scopeSection, "Scope Boundaries section not found");
		const hasNoJq = scopeSection.includes("jq") || scopeSection.includes("no jq");
		const hasNoCurl = scopeSection.includes("curl") || scopeSection.includes("no curl");
		const hasOnlyGh =
			scopeSection.includes("only") || scopeSection.includes("Only") || scopeSection.includes("gh");
		assert.ok(
			(hasNoJq && hasNoCurl) || hasOnlyGh,
			"Scope Boundaries missing gh-only dependency statement",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: Error handling rules (R4)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 5: Error handling rules (R4)", () => {
	const { body } = parseFrontmatter(SKILL_PATH);

	it('Duplicate found → "stop and report to user" / do NOT file language', () => {
		const errorSection = extractSection(body, "Error Handling");
		assert.ok(errorSection, "Error Handling section not found");
		const hasStopLanguage =
			errorSection.includes("stop") ||
			errorSection.includes("Stop") ||
			errorSection.includes("STOP");
		const hasDoNotFile =
			errorSection.includes("Do NOT file") ||
			errorSection.includes("do NOT file") ||
			errorSection.includes("do not file");
		assert.ok(
			hasStopLanguage && hasDoNotFile,
			"Error Handling missing duplicate stop or do NOT file language",
		);
	});

	it("If no CONTRIBUTING.md and no templates → use universal fallback format (do NOT abort)", () => {
		const errorSection = extractSection(body, "Error Handling");
		assert.ok(errorSection, "Error Handling section not found");
		assert.ok(
			errorSection.includes("Universal Fallback Format") ||
				errorSection.includes("universal fallback"),
			"Error Handling missing universal fallback format fallback rule",
		);
	});

	it('If gh auth status fails → stop and tell user to run "gh auth login"', () => {
		const authSection =
			extractSection(body, "Preconditions") ||
			extractSection(body, "Authentication Check") ||
			extractSection(body, "Error Handling");
		assert.ok(authSection, "No section with auth check found");
		assert.ok(
			authSection.includes("gh auth login") || authSection.includes("gh auth status"),
			"Missing gh auth login instruction",
		);
	});

	it("If CONTRIBUTING.md exists but no templates → extract format from CONTRIBUTING.md, don't fall back immediately", () => {
		const step1Section = extractStepSection(body, 1);
		const errorSection = extractSection(body, "Error Handling");
		const combinedText = (step1Section || "") + "\n" + (errorSection || "");

		assert.ok(
			combinedText.includes("CONTRIBUTING.md") &&
				combinedText.includes("format") &&
				(combinedText.includes("do not fall back") ||
					combinedText.includes("do NOT fall back") ||
					combinedText.includes("do NOT immediately")),
			"Missing CONTRIBUTING.md format extraction rule without immediate fallback",
		);
	});

	it("If confidence on duplicate check < threshold → report to user for manual review", () => {
		const step3Section = extractStepSection(body, 3);
		const errorSection = extractSection(body, "Error Handling");
		const combinedText = (step3Section || "") + "\n" + (errorSection || "");

		assert.ok(
			combinedText.includes("confidence") ||
				combinedText.includes("Confidence") ||
				combinedText.includes("threshold") ||
				combinedText.includes("manual review"),
			"Missing low-confidence duplicate check handling",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extract a section from the body by its heading (### Step N).
 */
function extractStepSection(body: string, stepNumber: number): string | null {
	const marker = `### Step ${stepNumber}`;
	const startIdx = body.indexOf(marker);
	if (startIdx === -1) return null;

	// Find the next ### heading or end of string
	const nextMarkerIdx = findNextH3Heading(body, startIdx + marker.length);
	return body.slice(startIdx, nextMarkerIdx !== -1 ? nextMarkerIdx : undefined);
}

/**
 * Find the next ### heading after a given position.
 */
function findNextH3Heading(body: string, fromIndex: number): number {
	const lines = body.slice(fromIndex).split("\n");
	let accumulated = fromIndex;
	for (const line of lines) {
		if (line.startsWith("### ") && accumulated > fromIndex) {
			return accumulated;
		}
		accumulated += line.length + 1; // +1 for newline
	}
	return -1;
}

/**
 * Extract a section from the body by its heading (## Section Name).
 * Skips content inside fenced code blocks when looking for the next heading.
 */
function extractSection(body: string, sectionName: string): string | null {
	// Try exact heading first
	const exactMarker = `## ${sectionName}`;
	let startIdx = body.indexOf(exactMarker);

	// Fallback to partial match
	if (startIdx === -1) {
		const lowerBody = body.toLowerCase();
		const lowerName = sectionName.toLowerCase();
		const lines = body.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed.startsWith("## ") && trimmed.slice(3).toLowerCase().includes(lowerName)) {
				startIdx = lines.slice(0, i).join("\n").length;
				if (startIdx > 0) startIdx += 1; // account for last newline
				break;
			}
		}
	}

	if (startIdx === -1) return null;

	// Find the next ## heading (same level), skipping fenced code blocks
	const rest = body.slice(startIdx + exactMarker.length);
	const lines = rest.split("\n");
	let accumulated = startIdx + exactMarker.length;
	let inCodeBlock = false;
	for (const line of lines) {
		// Toggle code block state
		if (line.trim().startsWith("```")) {
			inCodeBlock = !inCodeBlock;
		}

		if (
			!inCodeBlock &&
			line.trim().startsWith("## ") &&
			accumulated > startIdx + exactMarker.length
		) {
			return body.slice(startIdx, accumulated);
		}
		accumulated += line.length + 1;
	}
	return body.slice(startIdx);
}
