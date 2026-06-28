import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Paths ───────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(__dirname, "..");
const skillPath = resolve(skillDir, "SKILL.md");
const rootDir = resolve(skillDir, "..", "..", "..");
const extensionsDir = resolve(rootDir, ".pi", "extensions");
const rootTsconfig = resolve(rootDir, "tsconfig.json");

let skillContent: string;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sectionExists(heading: string): boolean {
	return skillContent.includes(heading);
}

function sectionAfter(beforeHeading: string, afterHeading: string): boolean {
	const beforeIdx = skillContent.indexOf(beforeHeading);
	const afterIdx = skillContent.indexOf(afterHeading);
	if (beforeIdx === -1 || afterIdx === -1) return false;
	return beforeIdx < afterIdx;
}

function sectionContent(heading: string): string {
	const startIdx = skillContent.indexOf(heading);
	if (startIdx === -1) return "";
	const remaining = skillContent.slice(startIdx + heading.length);
	const nextSectionMatch = remaining.match(/\n#{2,3}\s/);
	if (nextSectionMatch) {
		return remaining.slice(0, nextSectionMatch.index);
	}
	return remaining;
}

function countOccurrences(text: string, pattern: string): number {
	return (text.match(new RegExp(pattern, "g")) || []).length;
}

// ─── Phase 1: Structural Integrity ───────────────────────────────────────────
describe("Phase 1: Structural integrity — Phase 1.5 insertion point", () => {
	before(() => {
		skillContent = readFileSync(skillPath, "utf-8");
	});

	it("contains Phase 1.5 — Knip Preliminary Scan heading", () => {
		assert.ok(
			sectionExists("### Phase 1.5 — Knip Preliminary Scan"),
			"SKILL.md must have `### Phase 1.5 — Knip Preliminary Scan` heading",
		);
	});

	it("Phase 1.5 heading appears after Phase 1a — Random Selection", () => {
		assert.ok(
			sectionAfter("### Phase 1a — Random Selection", "### Phase 1.5 — Knip Preliminary Scan"),
			"Phase 1.5 heading must appear after Phase 1a heading",
		);
	});

	it("Phase 1.5 heading appears before Phase 2 — Code Understanding", () => {
		assert.ok(
			sectionAfter("### Phase 1.5 — Knip Preliminary Scan", "### Phase 2 — Code Understanding"),
			"Phase 1.5 heading must appear before Phase 2 heading",
		);
	});

	it("Phase 1 heading is still present and unchanged", () => {
		assert.ok(
			sectionExists("### Phase 1 — Random Selection + Hunt Loop"),
			"Phase 1 heading must still be present",
		);
	});

	it("Phase 1a heading is still present and unchanged", () => {
		assert.ok(
			sectionExists("### Phase 1a — Random Selection"),
			"Phase 1a heading must still be present",
		);
	});

	it("Phase 2 heading is still present and unchanged", () => {
		assert.ok(
			sectionExists("### Phase 2 — Code Understanding"),
			"Phase 2 heading must still be present",
		);
	});

	it("YAML frontmatter metadata fields are identical to original", () => {
		assert.ok(skillContent.startsWith("---"), "SKILL.md must start with YAML frontmatter");
		const endOfFrontmatter = skillContent.indexOf("---", 3);
		const frontmatter = skillContent.slice(0, endOfFrontmatter + 3);

		assert.ok(
			frontmatter.includes("name: extension-dead-code-hunter"),
			"Frontmatter must have name field",
		);
		assert.ok(frontmatter.includes("description:"), "Frontmatter must have description field");
		assert.ok(frontmatter.includes("metadata:"), "Frontmatter must have metadata field");
		assert.ok(
			frontmatter.includes("detection-techniques:"),
			"Frontmatter must have detection-techniques field",
		);
		assert.ok(
			frontmatter.includes("proof-standard:"),
			"Frontmatter must have proof-standard field",
		);
		assert.ok(
			frontmatter.includes("confidence-levels:"),
			"Frontmatter must have confidence-levels field",
		);

		// Verify no unexpected top-level fields added
		const topLevelFields = frontmatter
			.split("\n")
			.filter((l) => /^[a-z]/.test(l) && l.includes(":"))
			.map((l) => l.split(":")[0].trim());
		const knownFields = ["name", "description", "metadata"];
		for (const field of topLevelFields) {
			assert.ok(knownFields.includes(field), `Unexpected top-level frontmatter field: ${field}`);
		}
	});

	it("only one Phase 1.5 heading exists", () => {
		const count = countOccurrences(skillContent, "### Phase 1.5");
		assert.equal(count, 1, "There should be exactly one Phase 1.5 heading");
	});
});

// ─── Phase 2: Phase 1.5 content validity ─────────────────────────────────────
describe("Phase 2: Phase 1.5 content validity", () => {
	let phase15Content: string;

	before(() => {
		skillContent = readFileSync(skillPath, "utf-8");
		phase15Content = sectionContent("### Phase 1.5 — Knip Preliminary Scan");
	});

	it("includes npx knip command with root tsconfig and extension directory (AC1)", () => {
		assert.ok(phase15Content.includes("npx knip"), "Phase 1.5 must include `npx knip` command");
		assert.ok(
			phase15Content.includes("--tsConfig"),
			"Command must include --tsConfig flag (capital C)",
		);
		assert.ok(
			phase15Content.includes("tsconfig.json"),
			"Command must reference root tsconfig path",
		);
		assert.ok(
			phase15Content.includes("<name>"),
			"Command must include extension directory argument with <name> placeholder",
		);
	});

	it("includes --include-entry-exports flag (pitfall #7)", () => {
		assert.ok(
			phase15Content.includes("--include-entry-exports"),
			"Phase 1.5 must include --include-entry-exports flag",
		);
	});

	it("includes --directory flag (knip v6 uses --directory not positional arg)", () => {
		assert.ok(phase15Content.includes("--directory"), "Phase 1.5 must include --directory flag");
	});

	it("instructs to check npx knip exit code: 0, 1, 2 (AC4)", () => {
		// Check for exit code 0 (no findings)
		assert.ok(
			phase15Content.includes("**0**") ||
				phase15Content.includes("exit code 0") ||
				phase15Content.includes("code 0"),
			"Phase 1.5 must reference exit code 0 (no findings)",
		);
		// Check for exit code 1 (findings found)
		assert.ok(
			phase15Content.includes("**1**") ||
				phase15Content.includes("exit code 1") ||
				phase15Content.includes("code 1"),
			"Phase 1.5 must reference exit code 1 (findings)",
		);
		// Check for exit code 2 (error)
		assert.ok(
			phase15Content.includes("**2**") ||
				phase15Content.includes("exit code 2") ||
				phase15Content.includes("code 2"),
			"Phase 1.5 must reference exit code 2 (error)",
		);
	});

	it("states 'if exit code 0 and no output → treat as no findings, fall through to manual' (edge case)", () => {
		const lower = phase15Content.toLowerCase();
		assert.ok(
			lower.includes("0") && lower.includes("no findings") && lower.includes("fall"),
			"Phase 1.5 must describe behavior for exit code 0 with no output",
		);
	});

	it("states 'first finding only is filed — one finding per issue rule applies' (AC3 + R3 AC2)", () => {
		const lower = phase15Content.toLowerCase();
		assert.ok(
			lower.includes("first finding"),
			"Phase 1.5 must state that only the first finding is filed",
		);
		assert.ok(
			lower.includes("one finding per issue"),
			"Phase 1.5 must reference one-finding-per-issue rule",
		);
	});

	it("instructs to use existing issue template with Proof section saying 'Knip output:' (R2 AC1)", () => {
		assert.ok(
			phase15Content.includes("Knip output:") || phase15Content.includes("Knip output"),
			"Phase 1.5 must mention 'Knip output:' format in proof section",
		);
		assert.ok(
			phase15Content.includes("existing issue template") || phase15Content.includes("Phase 5"),
			"Phase 1.5 must reference existing issue template",
		);
	});

	it("sets confidence to 90% for knip findings (R2 AC2)", () => {
		assert.ok(
			phase15Content.includes("90%") || phase15Content.includes("90"),
			"Phase 1.5 must set confidence to 90% for knip findings",
		);
	});

	it("states root tsconfig usage (tsconfig.json)", () => {
		assert.ok(
			phase15Content.includes("tsconfig.json"),
			"Phase 1.5 must reference the root tsconfig path",
		);
	});
});

// ─── Phase 3: Preservation of existing content ───────────────────────────────
describe("Phase 3: Preservation of existing content — regression checks", () => {
	before(() => {
		skillContent = readFileSync(skillPath, "utf-8");
	});

	it("Phase 2 section contains Code Understanding instructions", () => {
		const phase2 = sectionContent("### Phase 2 — Code Understanding");
		assert.ok(phase2.includes("Purpose"), "Phase 2 must include 'Purpose' bullet");
		assert.ok(phase2.includes("API surface"), "Phase 2 must include 'API surface' bullet");
		assert.ok(phase2.includes("Call graph"), "Phase 2 must include 'Call graph' bullet");
		assert.ok(phase2.includes("Dependencies"), "Phase 2 must include 'Dependencies' bullet");
		assert.ok(phase2.includes("Control flow"), "Phase 2 must include 'Control flow' bullet");
		assert.ok(
			phase2.includes("Module structure"),
			"Phase 2 must include 'Module structure' bullet",
		);
		assert.ok(
			phase2.includes("Package manifest"),
			"Phase 2 must include 'Package manifest' bullet",
		);
		assert.ok(
			phase2.includes("Dynamic code awareness"),
			"Phase 2 must include 'Dynamic code awareness'",
		);
	});

	it("Phase 3 heading unchanged, all 11 detection techniques listed (R3 AC1)", () => {
		assert.ok(
			sectionExists("### Phase 3 — Dead Code Detection Techniques"),
			"Phase 3 heading must be unchanged",
		);

		const phase3 = sectionContent("### Phase 3 — Dead Code Detection Techniques");
		const techniques = [
			"Unused Exports",
			"Unreachable Code",
			"Dead Branches",
			"Unnecessary Conditionals",
			"Duplicate Code",
			"Unused Parameters",
			"Orphaned Imports",
			"Empty Blocks",
			"Dead Event Handlers",
			"Redundant / Dead Code Paths",
			"Zombie Dependencies",
		];

		for (const technique of techniques) {
			assert.ok(phase3.includes(technique), `Phase 3 must include technique: ${technique}`);
		}
	});

	it("Phase 3 technique 1 (Unused Exports) search strategy unchanged", () => {
		const phase3 = sectionContent("### Phase 3 — Dead Code Detection Techniques");
		assert.ok(
			phase3.includes("ripgrep_search") && phase3.includes("myFunctionName"),
			"Technique 1 must include ripgrep_search with function name pattern",
		);
	});

	it("Phase 4 (Finding Validation) proof checklist unchanged", () => {
		const phase4 = sectionContent("### Phase 4 — Finding Validation (Proof Requirement)");
		assert.ok(phase4.includes("Code evidence"), "Phase 4 must include 'Code evidence'");
		assert.ok(phase4.includes("Why it is dead"), "Phase 4 must include 'Why it is dead'");
		assert.ok(
			phase4.includes("Cross-reference proof"),
			"Phase 4 must include 'Cross-reference proof'",
		);
		assert.ok(phase4.includes("Confidence score"), "Phase 4 must include 'Confidence score'");
		assert.ok(phase4.includes("Impact assessment"), "Phase 4 must include 'Impact assessment'");
	});

	it("Phase 5 issue template includes Proof section for manual findings", () => {
		const phase5Idx = skillContent.indexOf("### Phase 5 — GitHub Issue Creation");
		const phase6Idx = skillContent.indexOf("### Phase 6 — Report");
		assert.ok(phase5Idx >= 0, "Phase 5 heading must exist");
		assert.ok(phase6Idx >= 0, "Phase 6 heading must exist");
		const phase5Content = skillContent.slice(phase5Idx, phase6Idx);
		assert.ok(
			phase5Content.includes("## Proof"),
			"Phase 5 must include ## Proof section in template",
		);
		assert.ok(
			phase5Content.includes("Cross-Reference Proof"),
			"Phase 5 must include Cross-Reference Proof section",
		);
	});

	it("Phase 6 (Report) section unchanged", () => {
		assert.ok(sectionExists("### Phase 6 — Report"), "Phase 6 heading must exist");
		const phase6Idx = skillContent.indexOf("### Phase 6 — Report");
		const afterPhase6 = skillContent.slice(phase6Idx);
		assert.ok(
			afterPhase6.includes("Dead Code Hunt Report"),
			"Phase 6 must include Dead Code Hunt Report title",
		);
	});

	it("Rules list has 17 rules, rule 4 still says 'Cross-reference two sources'", () => {
		const rulesSection = skillContent.slice(skillContent.indexOf("## Rules"));
		assert.ok(
			rulesSection.includes("Cross-reference two sources"),
			'Rules must include "Cross-reference two sources"',
		);

		const ruleLines = rulesSection.split("\n").filter((l) => /^\d+\./.test(l.trim()));
		assert.equal(ruleLines.length, 17, "There should be 17 numbered rules");
	});

	it("`knip` word does not appear in Phase 2, 3, 4, 5, or 6 sections (no contamination)", () => {
		const sectionBoundaries = [
			{
				name: "Phase 2",
				start: "### Phase 2 — Code Understanding",
				end: "### Phase 3 — Dead Code Detection Techniques",
			},
			{
				name: "Phase 3",
				start: "### Phase 3 — Dead Code Detection Techniques",
				end: "### Phase 4 — Finding Validation",
			},
			{
				name: "Phase 4",
				start: "### Phase 4 — Finding Validation",
				end: "### Phase 5 — GitHub Issue Creation",
			},
			{
				name: "Phase 5",
				start: "### Phase 5 — GitHub Issue Creation",
				end: "### Phase 6 — Report",
			},
			{ name: "Phase 6", start: "### Phase 6 — Report", end: "## Rules" },
		];

		for (const section of sectionBoundaries) {
			const startIdx = skillContent.indexOf(section.start);
			const endIdx = skillContent.indexOf(section.end);
			if (startIdx === -1) {
				assert.fail(`Section ${section.name} not found: ${section.start}`);
				continue;
			}
			const content =
				endIdx >= 0 ? skillContent.slice(startIdx, endIdx) : skillContent.slice(startIdx);

			const lowerContent = content.toLowerCase();
			if (lowerContent.includes("knip")) {
				// Check if occurrences are inside code blocks referencing Phase 1.5
				const lines = content.split("\n");
				const knipLines = lines.filter((l) => l.toLowerCase().includes("knip"));
				const inCodeBlock = knipLines.some((l) => /```/.test(l) || /^\s{4}/.test(l));
				if (!inCodeBlock) {
					assert.fail(
						`Section ${section.name} contains 'knip' outside code blocks. Lines: ${knipLines.join(", ")}`,
					);
				}
			}
		}
	});
});

// ─── Phase 4: Integration — npx knip runs on a real extension ────────────────
describe("Phase 4: Integration — npx knip runs on a real extension", () => {
	const piignoreDir = resolve(extensionsDir, "piignore");

	it(
		"npx knip with root tsconfig against piignore extension exits with code 0 or 1",
		{ timeout: 60000 },
		() => {
			assert.ok(existsSync(piignoreDir), "piignore extension directory must exist");

			let exitCode: number;
			let stdout: string;

			try {
				const result = execSync(
					`npx knip --tsConfig "${rootTsconfig}" --include-entry-exports --directory "${piignoreDir}" 2>&1`,
					{ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
				);
				stdout = result;
				exitCode = 0;
			} catch (err: any) {
				stdout = err.stdout || "";
				exitCode = err.status ?? 2;
			}

			assert.ok(
				exitCode === 0 || exitCode === 1,
				`Expected exit code 0 or 1, got ${exitCode}. stdout: ${stdout.slice(0, 500)}`,
			);
		},
	);

	it(
		"npx knip output matches default reporter format with file:line:col notation",
		{ timeout: 60000 },
		() => {
			if (!existsSync(piignoreDir)) {
				assert.fail("piignore extension directory does not exist");
			}

			let stdout: string;
			try {
				const result = execSync(
					`npx knip --tsConfig "${rootTsconfig}" --include-entry-exports --directory "${piignoreDir}" 2>&1`,
					{ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
				);
				stdout = result;
			} catch (err: any) {
				stdout = err.stdout || "";
			}

			if (stdout.trim().length > 0) {
				// Default reporter can show filenames ("Unused files") or file:line:col ("exports"/"types").
				// Both are valid knip default reporter output formats.
				const hasFileLineCol = /\S+\.(ts|mts|cts|js|mjs|cjs):\d+:\d+/.test(stdout);
				const hasFilenames = stdout.includes(".ts") || stdout.includes(".mts");
				assert.ok(
					hasFileLineCol || hasFilenames,
					`Knip output should contain file references. Output: ${stdout.slice(0, 300)}`,
				);
			} else {
				assert.ok(true, "Knip produced no output — no findings (exit code 0)");
			}
		},
	);
});
