import { describe, it } from "node:test";

import assert from "node:assert/strict";

import { mkdirSync, writeFileSync } from "node:fs";

import { join, dirname } from "node:path";

import {
	type TraceabilityGap,
	type FilteredIssueData,
	isTestableFile,
	parseIssueBodyChecklists,
	extractTitleVerb,
	extractChecklistKeywords,
	classifyDiffDirection,
} from "../checks/requirements-traceability.ts";

import type { ExecFn } from "../checks/shared.ts";

function mockExec(lines: string[]): ExecFn {
	return async (cmd: string, args: string[]) => {
		if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
			return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("diff") && args.includes("--name-only")) {
			const nameOnly = lines
				.map((l) => l.replace(/^[A-Z]\d*\s+/, "").replace(/\s+.*$/, ""))
				.filter(Boolean);
			return { code: 0, stdout: nameOnly.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("grep")) {
			return { code: 1, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

function mockExecPaths(paths: string[]): ExecFn {
	return async (cmd: string, args: string[]) => {
		if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
			const lines = paths.map((p) => `A ${p}`);
			return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("diff") && args.includes("--name-only")) {
			return { code: 0, stdout: paths.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("grep")) {
			return { code: 1, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

function createTempDir(prefix: string, files: Record<string, string>): string {
	const baseDir = join(process.cwd(), "ignore");
	const tempDir = join(baseDir, `rt-test-${prefix}-${Date.now()}`);
	for (const [relPath, content] of Object.entries(files)) {
		const fullPath = join(tempDir, relPath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content);
	}
	return tempDir;
}

function mockExecWithGrep(lines: string[], grepStdout: string | null): ExecFn {
	return async (cmd: string, args: string[]) => {
		if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
			return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("diff") && args.includes("--name-only")) {
			const nameOnly = lines
				.map((l) => l.replace(/^[A-Z]\d*\s+/, "").replace(/\s+.*$/, ""))
				.filter(Boolean);
			return { code: 0, stdout: nameOnly.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("grep")) {
			if (grepStdout !== null) {
				return { code: 0, stdout: grepStdout, stderr: "" };
			}
			return { code: 1, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

describe("isTestableFile()", () => {
	it("src/foo.ts → true (source extension)", () => {
		assert.equal(isTestableFile("src/foo.ts"), true);
	});

	it("src/foo.tsx → true", () => {
		assert.equal(isTestableFile("src/foo.tsx"), true);
	});

	it("src/foo.mts → true", () => {
		assert.equal(isTestableFile("src/foo.mts"), true);
	});

	it("src/foo.py → true", () => {
		assert.equal(isTestableFile("src/foo.py"), true);
	});

	it("src/foo.go → true", () => {
		assert.equal(isTestableFile("src/foo.go"), true);
	});

	it("src/foo.d.ts → false (type declaration)", () => {
		assert.equal(isTestableFile("src/foo.d.ts"), false);
	});

	it("src/generated/api.ts → false (under generated/)", () => {
		assert.equal(isTestableFile("src/generated/api.ts"), false);
	});

	it("src/vendor/lib.ts → false (under vendor/)", () => {
		assert.equal(isTestableFile("src/vendor/lib.ts"), false);
	});

	it("src/index.ts → false (barrel re-export)", () => {
		assert.equal(isTestableFile("src/index.ts"), false);
	});

	it("config.json → false (no source extension)", () => {
		assert.equal(isTestableFile("config.json"), false);
	});

	it("src/styles.css → false", () => {
		assert.equal(isTestableFile("src/styles.css"), false);
	});

	it("empty string → false", () => {
		assert.equal(isTestableFile(""), false);
	});

	it("src/barrel-index/index.ts → false (barrel re-export)", () => {
		assert.equal(isTestableFile("src/barrel-index/index.ts"), false);
	});

	it("src/generated/sub/auth.ts → false (under generated/)", () => {
		assert.equal(isTestableFile("src/generated/sub/auth.ts"), false);
	});

	it("vendor/lib.ts → false (under vendor/)", () => {
		assert.equal(isTestableFile("vendor/lib.ts"), false);
	});

	it("src/foo.js (non-TS source) → true", () => {
		assert.equal(isTestableFile("src/foo.js"), true);
	});

	it("src/foo.mjs → true", () => {
		assert.equal(isTestableFile("src/foo.mjs"), true);
	});

	it("src/foo.rs → true", () => {
		assert.equal(isTestableFile("src/foo.rs"), true);
	});

	it("src/foo.java → true", () => {
		assert.equal(isTestableFile("src/foo.java"), true);
	});

	it("src/foo.jsx → true", () => {
		assert.equal(isTestableFile("src/foo.jsx"), true);
	});

	it("README.md → false", () => {
		assert.equal(isTestableFile("README.md"), false);
	});
});
describe("parseIssueBodyChecklists()", () => {
	it("returns items from body with - [ ] (unchecked)", () => {
		const body = `## Tasks
- [ ] Add user authentication
- [ ] Create login page`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 2);
		assert.equal(result[0]!.text, "Add user authentication");
		assert.equal(result[0]!.checked, false);
		assert.equal(result[1]!.text, "Create login page");
		assert.equal(result[1]!.checked, false);
	});

	it("extracts checked - [x] items as completed tasks", () => {
		const body = `## Tasks
- [x] Setup project
- [ ] Implement feature`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 2);
		assert.equal(result[0]!.text, "Setup project");
		assert.equal(result[0]!.checked, true);
		assert.equal(result[1]!.text, "Implement feature");
		assert.equal(result[1]!.checked, false);
	});

	it("excludes items under Prerequisites heading", () => {
		const body = `## Prerequisites
- [ ] Clone repo
- [ ] Install Node.js

## Implementation
- [ ] Write code
- [ ] Add tests`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 2);
		assert.equal(result[0]!.text, "Write code");
		assert.equal(result[1]!.text, "Add tests");
	});

	it("excludes items under Setup heading", () => {
		const body = `## Setup
- [ ] Configure env

## Tasks
- [ ] Build feature`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.text, "Build feature");
	});

	it("includes items under Tasks, Implementation, Checklist sections", () => {
		const body = `## Checklist
- [ ] Item A
- [ ] Item B`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 2);
	});

	it("returns empty array when body has no checklists", () => {
		assert.deepEqual(parseIssueBodyChecklists("Just some text"), []);
	});

	it("returns empty array for empty body string", () => {
		assert.deepEqual(parseIssueBodyChecklists(""), []);
	});

	it("handles items with nested formatting (code, bold, links)", () => {
		const body = `## Tasks
- [ ] Add \`login()\` function
- [ ] **Bold task** item
- [ ] See [docs](https://example.com)`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 3);
		assert.match(result[0]!.text, /login/);
		assert.match(result[1]!.text, /Bold/);
		assert.match(result[2]!.text, /docs/);
	});

	it("handles items with * bullet syntax", () => {
		const body = `## Tasks
* [ ] Task with star bullet`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.text, "Task with star bullet");
	});

	it("handles items with + bullet syntax", () => {
		const body = `## Tasks
+ [ ] Task with plus bullet`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.text, "Task with plus bullet");
	});

	it("excludes items under H1/H3 meta-headings", () => {
		const h1 = `# Setup
- [ ] Configure env

## Tasks
- [ ] Build feature`;
		assert.deepEqual(parseIssueBodyChecklists(h1), [{ text: "Build feature", checked: false }]);

		const h3 = `### Prerequisites
- [ ] Clone repo

## Implementation
- [ ] Write code`;
		assert.deepEqual(parseIssueBodyChecklists(h3), [{ text: "Write code", checked: false }]);
	});

	it("tracks H4 headings but does not exclude them", () => {
		const body = `#### Tasks
- [ ] Build feature`;
		assert.deepEqual(parseIssueBodyChecklists(body), [{ text: "Build feature", checked: false }]);
	});

	it("normalizes closing hashes, formatting, colon, and case for exclusion", () => {
		assert.deepEqual(
			parseIssueBodyChecklists("### Reproduction Steps ###\n- [ ] Install deps"),
			[],
		);
		assert.deepEqual(parseIssueBodyChecklists("## **Setup**\n- [ ] Configure env"), []);
		assert.deepEqual(parseIssueBodyChecklists("### Steps To Reproduce:\n- [ ] Install deps"), []);
	});
});
describe("extractTitleVerb()", () => {
	it("'add: new feature' → 'add'", () => {
		assert.equal(extractTitleVerb("add: new feature"), "add");
	});

	it("'implement login flow' → 'implement'", () => {
		assert.equal(extractTitleVerb("implement login flow"), "implement");
	});

	it("'remove deprecated API' → 'remove'", () => {
		assert.equal(extractTitleVerb("remove deprecated API"), "remove");
	});

	it("'delete old adapter' → 'delete'", () => {
		assert.equal(extractTitleVerb("delete old adapter"), "delete");
	});

	it("'migrate from X to Y' → 'migrate'", () => {
		assert.equal(extractTitleVerb("migrate from X to Y"), "migrate");
	});

	it("'fix: bug in auth' → null (non-imperative)", () => {
		assert.equal(extractTitleVerb("fix: bug in auth"), null);
	});

	it("'refactor: extract method' → null", () => {
		assert.equal(extractTitleVerb("refactor: extract method"), null);
	});

	it("'update dependencies' → null", () => {
		assert.equal(extractTitleVerb("update dependencies"), null);
	});

	it("empty string → null", () => {
		assert.equal(extractTitleVerb(""), null);
	});

	it("'Add login' (capitalized) → 'add'", () => {
		assert.equal(extractTitleVerb("Add login"), "add");
	});

	it("'CREATE new module' (uppercase) → 'create'", () => {
		assert.equal(extractTitleVerb("CREATE new module"), "create");
	});

	it("'Migrate from v1 to v2' (capitalized) → 'migrate'", () => {
		assert.equal(extractTitleVerb("Migrate from v1 to v2"), "migrate");
	});
});
describe("extractChecklistKeywords()", () => {
	it("extract significant nouns from item", () => {
		const items = [{ text: "Add user authentication flow", checked: false }];
		const result = extractChecklistKeywords(items);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.item, "Add user authentication flow");
		assert.ok(result[0]!.keywords.includes("user"));
		assert.ok(result[0]!.keywords.includes("authentication"));
		assert.ok(result[0]!.keywords.includes("flow"));
	});

	it("strips stop words ('the', 'a', 'an', 'to', 'for')", () => {
		const items = [{ text: "Create the API for user module", checked: false }];
		const result = extractChecklistKeywords(items);
		assert.equal(result.length, 1);
		assert.ok(result[0]!.keywords.includes("Create"));
		assert.ok(result[0]!.keywords.includes("API"));
		assert.ok(result[0]!.keywords.includes("user"));
		assert.ok(result[0]!.keywords.includes("module"));
		assert.equal(result[0]!.keywords.includes("the"), false);
		assert.equal(result[0]!.keywords.includes("for"), false);
	});

	it("returns one entry per checklist item", () => {
		const items = [
			{ text: "Add login", checked: false },
			{ text: "Add logout", checked: false },
		];
		const result = extractChecklistKeywords(items);
		assert.equal(result.length, 2);
	});

	it("handles empty checklist array → empty array", () => {
		assert.deepEqual(extractChecklistKeywords([]), []);
	});

	it("extracts from items with code formatting", () => {
		const items = [{ text: "Add `login()` function", checked: false }];
		const result = extractChecklistKeywords(items);
		assert.equal(result.length, 1);
		assert.ok(result[0]!.keywords.some((k) => k.includes("login") || k.includes("function")));
	});
});
describe("classifyDiffDirection()", () => {
	it("'add login' with A > D → expects net additions", () => {
		const result = classifyDiffDirection("add login", ["A src/login.ts", "M src/index.ts"]);
		assert.equal(result, "additions");
	});

	it("'remove old-api' with D > A → expects net deletions", () => {
		const result = classifyDiffDirection("remove old-api", ["D src/old-api.ts", "M src/index.ts"]);
		assert.equal(result, "deletions");
	});

	it("'migrate from X to Y' with D+A → expects net deletions", () => {
		const result = classifyDiffDirection("migrate from X to Y", ["D src/X.ts", "A src/Y.ts"]);
		assert.equal(result, "deletions");
	});

	it("'fix bug' (non-directional verb) → null", () => {
		const result = classifyDiffDirection("fix bug", ["M src/bug.ts"]);
		assert.equal(result, null);
	});

	it("title contains both 'add' and 'remove' → null (skip ambiguous)", () => {
		const result = classifyDiffDirection("add and remove things", ["A src/new.ts", "D src/old.ts"]);
		assert.equal(result, null);
	});

	it("null verb → null", () => {
		const result = classifyDiffDirection(null, ["A src/file.ts"]);
		assert.equal(result, null);
	});

	it("'add login' with only modifications → null (no additions/deletions)", () => {
		const result = classifyDiffDirection("add login", ["M src/login.ts"]);
		assert.equal(result, null);
	});

	it("'delete old' with net additions detected → expects deletions (verb wins)", () => {
		const result = classifyDiffDirection("delete old", ["A src/new.ts", "D src/old.ts"]);
		assert.equal(result, "deletions");
	});
});
