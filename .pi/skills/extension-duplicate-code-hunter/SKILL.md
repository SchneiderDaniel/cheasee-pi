---
name: extension-duplicate-code-hunter
description: Systematic duplicate code detection for pi extensions. Picks random extension, analyzes for exact, renamed, near-miss, and semantic clones. Validates with proof, creates GitHub issue. Use before releases or when auditing extension quality.
metadata:
  detection-techniques: exact-clones,renamed-clones,near-miss-clones,semantic-clones,intra-file-clones,inter-file-clones,copy-paste-blocks,repeated-condition-chains,repeated-switch-cases,duplicate-imports,triplicate-plus
  clone-types: type1-exact,type2-renamed,type3-near-miss,type4-semantic
  proof-standard: three-way-match
  confidence-levels: 100pct-certain,90pct-strong,70pct-likely
---

# Duplicate Code Hunter

Systematic duplicate code hunter for pi extensions. **Hunt until duplicate found.** Each invocation picks random extension, analyzes using structured techniques, validates with proof, files GitHub issue. If no duplicate found in selected extension, discard it and pick another. Repeat until one finding is confirmed and filed.

## Pipeline Integration

This skill powers two workflows:

1. **Per-PR Gate (Automated):** The supervisor pipeline runs `jscpd` on the full worktree during the Implementation → Audit transition. Clones where at least one location is in a changed file (from `git diff <default-branch> --name-only`) are flagged. Results are surfaced as a warning and injected into the auditor's task context as the `duplicate-code` dimension.

2. **One-Off Audits (Manual):** The original random-extension hunt loop for periodic quality sweeps. Run via the auditor agent when the `extension-duplicate-code-hunter` skill is configured.

The per-PR gate uses `checks/duplicate-code.ts` which applies the same minimum thresholds (5 lines, 50 tokens) and clone type classification as this skill. False positive filtering (generated code, license headers, shared abstractions, intentional symmetry) is applied by the auditor during review.

## How It Works

### Phase 1 — Random Selection + Hunt Loop

This is a **hunt loop**. Core instruction: **keep hunting until you file at least one finding.**

```
loop:
  1. Pick random extension from .pi/extensions/ (skip previously picked)
  2. Install/tool check (Phase 1b)
  3. Run Phase 2-4 (understand + hunt + validate)
  4. If duplicate code found AND proof confirmed → file GitHub issue (Phase 5) → exit loop
  5. If no duplicate found → log reason, goto loop start (pick next extension)
  6. If ALL extensions exhausted with zero findings → output "Hunt complete: 0 duplicate code findings across all extensions"
```

**Critical rule:** Do NOT lower proof standards when hunt gets long. A finding without proof is not a finding. Skip and move on.

**Deterministic-first rule:** All proof must come from deterministic tools (`jscpd`, `ripgrep_search`, `structural_search`, `diff`, manual code trace) — never from asking the LLM "is this code duplicated?" If you cannot find proof with a deterministic tool or trace the duplication, the finding is speculative and must be skipped.

### Phase 1a — Random Selection

Pick one extension from `.pi/extensions/` using `bash ls`. Prefer subdirectory extensions (they contain multiple files, more surface area). Single-file `.ts` extensions also eligible. Do NOT pick same extension twice in a row within same invocation.

Selection method:

```bash
ls -d .pi/extensions/*/   # subdirectory extensions
ls .pi/extensions/*.ts     # single-file extensions
```

Pick randomly. Document which extension selected and why (e.g. "largest file count" or "most recently modified").

### Phase 1b — Tool Setup

Detect and install deterministic duplicate detection tools. These are **optional accelerators** — the skill works without them using built-in ripgrep_search + structural_search, but jscpd provides faster token-based scanning.

```bash
# Check if jscpd is available
which jscpd 2>/dev/null && jscpd --version

# If absent, safe to install (package created 2013-06-03, >14 days)
npm install -g jscpd 2>/dev/null

# Verify installation
which jscpd
```

**jscpd safety check:** Creation date 2013-06-03 (well above 14-day threshold). Safe to install.

**Fallback mode:** If jscpd cannot be installed or fails, use ripgrep_search + structural_search only. Document which tools used.

### Phase 2 — Code Understanding

Read the full extension before hunting. Use `read` to load all files.

For subdirectory extensions:

```bash
ls -la .pi/extensions/<name>/
read .pi/extensions/<name>/index.ts
read .pi/extensions/<name>/<other-files>.ts
```

For single-file extensions:

```bash
read .pi/extensions/<name>.ts
```

Understand:

- Purpose (what does it register? tool? command? event handler?)
- File count and structure (how many files, what patterns)
- Code patterns (repeated blocks, similar function signatures, copy-paste regions)
- Identifier naming conventions (similar function names, parameter patterns)
- Module boundaries (which files share similar logic)

**Duplicate susceptibility assessment:** Note patterns that increase duplicate risk:

- Functions with very similar signatures (same params, same return shape)
- Repeated conditional chains (if/else if or switch/case with similar bodies)
- Helper/utility functions spread across multiple files
- Copied configuration blocks
- Event handlers with identical setup/teardown logic
- Boilerplate patterns repeated per file or per module

### Phase 3 — Duplicate Code Detection Techniques

Apply each technique below. For each, document what you checked and whether found anything. Assign a **clone type** and **confidence level** to each finding.

#### Clone Type Classification

| Type   | Name            | Definition                                            | Confidence |
| ------ | --------------- | ----------------------------------------------------- | ---------- |
| Type 1 | Exact clone     | Identical code except whitespace/comments             | 100%       |
| Type 2 | Renamed clone   | Same structure, identifiers/some literals differ      | 90%        |
| Type 3 | Near-miss clone | Same structure with added/removed/modified statements | 70%        |
| Type 4 | Semantic clone  | Different syntax, same functionality                  | 60%-LLM    |

**Deterministic priority:** Type 1 > Type 2 > Type 3 > Type 4. Always prefer filing higher clone types first.

| Confidence | Meaning                                             | Typical for            |
| ---------- | --------------------------------------------------- | ---------------------- |
| 100%       | Certain — exact text match across two locations     | Type 1 exact clone     |
| 90%        | Strong — same AST shape, only names/literals differ | Type 2 renamed clone   |
| 70%        | Likely — similar structure with minor differences   | Type 3 near-miss clone |
| 60%        | LLM-assisted — different structure, same function   | Type 4 semantic clone  |

---

#### 1. Exact Clones (Type 1) — Deterministic

Identical code block appears ≥2 times in the extension. Whitespace and comment differences tolerated.

**Detection method A — jscpd (recommended):**

```bash
# Run jscpd on the extension directory
jscpd .pi/extensions/<name>/ --min-lines 5 --min-tokens 50 --output json

# Parse output for exact clones
# Flags:
#   --min-lines 5    Minimum duplicate block length (5+ lines)
#   --min-tokens 50  Minimum duplicate token count
#   --output json    Machine-readable output
```

**Detection method B — ripgrep_search multi-line pattern (fallback):**

```bash
# Extract first/last lines of suspected duplicate block into a literal file
# Search for that literal pattern across all extension files
ripgrep_search "literal unique string from block" .pi/extensions/<name>/
```

**Detection method C — manual block comparison:**

```bash
# Extract suspected duplicate blocks to temp files and diff them
read .pi/extensions/<name>/file.ts --offset 100 --limit 20 > /tmp/block1
read .pi/extensions/<name>/other.ts --offset 50 --limit 20 > /tmp/block2
diff /tmp/block1 /tmp/block2
```

**Patterns:**

```typescript
// EXACT CLONE — same 10-line block in two files
// File A: do-something.ts
function validateInput(data: Record<string, unknown>): boolean {
	if (!data || typeof data !== "object") return false;
	if (!data.id || typeof data.id !== "string") return false;
	if (!data.name || typeof data.name !== "string") return false;
	if (data.id.length > 100) return false;
	if (data.name.length > 500) return false;
	return true;
}

// File B: process-item.ts — identical function (same name, same body)
function validateInput(data: Record<string, unknown>): boolean {
	if (!data || typeof data !== "object") return false;
	if (!data.id || typeof data.id !== "string") return false;
	if (!data.name || typeof data.name !== "string") return false;
	if (data.id.length > 100) return false;
	if (data.name.length > 500) return false;
	return true;
}

// EXACT CLONE — copy-paste with only renamed blocks
// File A: build paths one way
const dataPath = path.join(ctx.cwd, "data", "config.json");
const logPath = path.join(ctx.cwd, "logs", "app.log");

// File B: same structure, same paths
const dataPath = path.join(ctx.cwd, "data", "config.json");
const logPath = path.join(ctx.cwd, "logs", "app.log");
```

#### 2. Renamed Clones (Type 2) — Deterministic

Same AST structure, same statement order, but identifiers and/or literal values differ.

**Detection method A — structural_search AST matching:**

```bash
# Use meta-variables to match structure regardless of identifiers
structural_search "function $NAME($PARAMS) { $$$BODY }" ts
```

For more specific patterns, search for the shape:

```bash
# Find all functions with similar parameter patterns and body shapes
structural_search "if (!$A || typeof $A !== $TYPE) $$$RETURN" ts
```

**Detection method B — jscpd token mode:**

```bash
# jscpd normalizes identifiers by default — output includes Type 2 clones
jscpd .pi/extensions/<name>/ --min-lines 5 --min-tokens 50 --output json
```

**Detection method C — manual comparison with normalized diff:**

```bash
# Extract blocks, normalize identifiers, then diff
# Create normalized versions by replacing identifiers with placeholders
sed 's/\b[a-zA-Z_][a-zA-Z0-9_]*\b/ID/g' /tmp/block1 > /tmp/block1.norm
sed 's/\b[a-zA-Z_][a-zA-Z0-9_]*\b/ID/g' /tmp/block2 > /tmp/block2.norm
diff /tmp/block1.norm /tmp/block2.norm
```

**Patterns:**

```typescript
// RENAMED CLONE — same logic, different variable names
// Block A
function formatUserMessage(name: string, age: number): string {
	const greeting = `Hello, ${name}!`;
	const details = `You are ${age} years old.`;
	return `${greeting} ${details}`;
}

// Block B — same structure, different names
function formatProductDescription(title: string, price: number): string {
	const intro = `Introducing ${title}!`;
	const pricing = `It costs $${price}.`;
	return `${intro} ${pricing}`;
}

// RENAMED CLONE — copy-paste with find-replace
// Block A
const okStatus = 200;
const createdStatus = 201;
const notFoundStatus = 404;

// Block B — same assignment pattern, different constants
const successCode = 200;
const createdCode = 201;
const missingCode = 404;
```

#### 3. Near-Miss Clones (Type 3) — Deterministic + LLM

Same overall structure but with added, removed, or modified statements. Some statements differ while the block layout is preserved.

**Detection method A — jscpd (handles near-miss with --min-lines + threshold):**

```bash
# jscpd uses token-based comparison which naturally catches near-misses
jscpd .pi/extensions/<name>/ --min-lines 5 --min-tokens 30 \
  --output json --threshold 15
# --threshold 15 = allow 15% tolerance for differences
```

**Detection method B — pairwise line alignment:**

```bash
# Extract two similar blocks and side-by-side diff
diff --side-by-side --width=160 /tmp/block1 /tmp/block2
# Count matching vs differing lines. If >60% match, classified as near-miss
```

**Detection method C — LLM-assisted (only for borderline cases):**
Only use when deterministic tools flag high-similarity blocks (>60% match) but classification between Type 2 and Type 3 is ambiguous. LLM role: classify the clone, not find it.

**Patterns:**

```typescript
// NEAR-MISS CLONE — same setup/teardown, different middle
// Block A
async function handleCreate(params: CreateParams, ctx: Context) {
	const { name, data } = params;
	const session = ctx.session;
	const filePath = path.join(ctx.cwd, "data", name);
	await fs.writeFile(filePath, JSON.stringify(data));
	return { ok: true, path: filePath };
}

// Block B — same setup, same teardown, different middle operation
async function handleRead(params: ReadParams, ctx: Context) {
	const { name } = params; // slightly different destructure
	const session = ctx.session; // same
	const filePath = path.join(ctx.cwd, "data", name); // same
	const content = await fs.readFile(filePath, "utf-8"); // different op
	return { ok: true, content }; // different return shape
}

// NEAR-MISS — same condition chain, extra branch inserted
// Block A
if (role === "admin") return fullAccess;
if (role === "editor") return limitedAccess;
if (role === "viewer") return readOnly;
return deny;

// Block B — same branches plus one extra
if (role === "superadmin") return fullAccess; // inserted
if (role === "admin") return fullAccess;
if (role === "editor") return limitedAccess;
if (role === "viewer") return readOnly;
return deny;
```

#### 4. Semantic Clones (Type 4) — LLM-Assisted

Different code structure and syntax but same functional behavior. LLM required for detection — this is the only technique where LLM opinion is acceptable as the primary detection mechanism.

**Process:**

1. LLM reads full extension and identifies functions/modules that appear to serve the same purpose
2. LLM provides a reasoning chain showing why they are semantically equivalent
3. Code snippet from both locations shown as proof
4. Cross-referenced with at least one deterministic tool to confirm structural similarity

**Constraints:**

- Only file Type 4 findings if you can articulate a clear reasoning chain
- Always show both code snippets
- Confidence: 60% max
- Prefer filing Type 1-3 over Type 4 when both exist

**Patterns:**

```typescript
// SEMANTIC CLONE — same behavior, different syntax
// Version A: for loop
function sumArrayA(items: number[]): number {
	let total = 0;
	for (let i = 0; i < items.length; i++) {
		total += items[i];
	}
	return total;
}

// Version B: reduce
function sumArrayB(values: number[]): number {
	return values.reduce((acc, v) => acc + v, 0);
}
```

#### 5. Intra-File Duplicate Blocks

Duplicates that appear within the same file. Often from copy-paste within a single module.

**Detection method:**

```bash
# For each function/block in the file, search for its content elsewhere in the same file
# Use distinctive lines from the block as search pattern
ripgrep_search "distinctive line from block" .pi/extensions/<name>/<file>.ts
```

**Patterns:**

```typescript
// INTRA-FILE DUPLICATE — identical validation in two methods
class DataManager {
	async createRecord(data: Record<string, unknown>) {
		if (!data.id || typeof data.id !== "string") throw new Error("invalid"); // ←
		if (!data.name || typeof data.name !== "string") throw new Error("invalid"); // ←
		// ... create logic
	}

	async updateRecord(data: Record<string, unknown>) {
		// same validation block repeated
		if (!data.id || typeof data.id !== "string") throw new Error("invalid"); // ← dup
		if (!data.name || typeof data.name !== "string") throw new Error("invalid"); // ← dup
		// ... update logic
	}
}

// INTRA-FILE DUPLICATE — same config block repeated
const TOOL_A_CONFIG = {
	name: "tool-a",
	description: "Does something",
	params: t.Object({ input: t.String() }),
};

const TOOL_B_CONFIG = {
	name: "tool-b",
	description: "Does something else",
	params: t.Object({ input: t.String() }), // identical to TOOL_A_CONFIG.params
};
```

#### 6. Repeated Conditional Chains (Duplicated if/else if / switch-case)

The same condition chain appears in two or more places. Copy-pasted business logic.

**Detection method A — structural_search:**

```bash
# Find all if/else-if chains and compare their structures
structural_search "if ($A) $$$THEN else if ($B) $$$ELSE" ts
```

**Detection method B — ripgrep_search for literal condition text:**

```bash
# Search for characteristic condition text
ripgrep_search "role === "admin"" .pi/extensions/<name>/
```

**Patterns:**

```typescript
// REPEATED CONDITION CHAIN — same role check in two places
function getAccessLevel(role: string): string {
	if (role === "admin") return "full";
	if (role === "editor") return "limited";
	if (role === "viewer") return "read";
	return "deny";
}

function getPermissions(role: string): string[] {
	if (role === "admin") return ["r", "w", "x"]; // ← same condition
	if (role === "editor") return ["r", "w"]; // ← same condition
	if (role === "viewer") return ["r"]; // ← same condition
	return [];
}

// REPEATED SWITCH — same cases, different bodies
switch (status) {
	case "loading":
		showLoader();
		break;
	case "success":
		showData();
		break;
	case "error":
		showError();
		break;
}
// ... elsewhere ...
switch (status) {
	case "loading":
		displaySpinner();
		break; // diff body
	case "success":
		renderContent();
		break; // diff body
	case "error":
		displayAlert();
		break; // diff body
}
// Same condition chain is duplicated even though bodies differ
```

#### 7. Duplicate Imports / Re-exports

The same import or re-export pattern appears in multiple files, or files import the same module with redundant specifiers.

**Detection method:**

```bash
# Find all imports from a specific module
ripgrep_search "from '"../common"" .pi/extensions/<name>/
# If many files import the same module with identical specifiers, flag it
```

**Patterns:**

```typescript
// DUPLICATE IMPORTS — three files import same thing with overlapping specifiers
// File A: import { ToolContext } from "../types";
// File B: import { ToolContext } from "../types";  ← dup
// File C: import { ToolResult } from "../types";
// File B could re-export from A or share type import

// DUPLICATE RE-EXPORTS — barrel file pattern
// index.ts: export { helperA } from "./helperA";
// utils.ts: export { helperA } from "./helperA";  ← dup
```

#### 8. Triplicate+ Clones

Code blocks that appear in 3+ locations (not just 2). Higher impact — more maintenance burden, more bug-propagation risk.

**Detection method:**

```bash
# Use jscpd — it finds all clone locations, not just pairs
jscpd .pi/extensions/<name>/ --min-lines 3 --output json

# Or use ripgrep_search to find all occurrences of a distinctive pattern
ripgrep_search "distinctive pattern" .pi/extensions/<name>/
# Count occurrences > 2
```

**Patterns:**

```typescript
// TRIPLICATE — same error handling in 4 files
// File A
async function createItem(data: Data) {
	try {
		return await db.insert(data);
	} catch (err) {
		throw new AppError("create failed", { cause: err });
	}
}
// File B
async function updateItem(data: Data) {
	try {
		return await db.update(data);
	} catch (err) {
		throw new AppError("update failed", { cause: err });
	}
}
// File C
async function deleteItem(id: string) {
	try {
		return await db.delete({ id });
	} catch (err) {
		throw new AppError("delete failed", { cause: err });
	}
}
// File D
async function queryItem(filter: Filter) {
	try {
		return await db.find(filter);
	} catch (err) {
		throw new AppError("query failed", { cause: err });
	}
}
```

#### 9. Boilerplate / Template Code Duplication

Code blocks generated from templates or boilerplate that should be generated programmatically.

**Detection method:**

```bash
# Look for highly repetitive patterns in file headers, license blocks, config sections
read .pi/extensions/<name>/<file>.ts | head -20
# Check if same header/license/config block repeated across files
```

**Patterns:**

```typescript
// BOILERPLATE — same file header pattern
// ~5 identical lines across 10+ files
// File A (top of file)
import { defineExtension } from "pi";
import type { ToolContext } from "../types";
import * as t from "typebox";

// File B (top of file) — identical
import { defineExtension } from "pi";
import type { ToolContext } from "../types";
import * as t from "typebox";
```

### Phase 4 — Finding Validation (Proof Requirement)

Every suspected duplicate code finding MUST have deterministic proof. Rule: **"Three-way match"** — three independent confirmations before filing.

#### Proof Standard Matrix

| Clone Type | Proof Method 1                 | Proof Method 2                       | Proof Method 3                          |
| ---------- | ------------------------------ | ------------------------------------ | --------------------------------------- |
| Type 1     | jscpd output or ripgrep_search | Read both blocks, visual comparison  | diff between blocks shows 0 differences |
| Type 2     | jscpd output                   | structural_search AST match          | Normalized diff shows 0 differences     |
| Type 3     | jscpd output with --threshold  | Structural line-alignment >60% match | LLM classification of clone type        |
| Type 4     | LLM semantic analysis          | Structural similarity check          | Both code snippets shown                |

**Deterministic-only path:** For Type 1-2, all proof must be from deterministic tools. For Type 3, jscpd/lines alignment must identify the pair, LLM may classify. For Type 4, LLM is the primary detector but proof must include both code snippets with line references.

**No LLM-opinion evidence for Type 1-2:** Evidence must come from deterministic sources — tool output (`jscpd`, `ripgrep_search`, `structural_search`, `diff`), or file contents (manual comparison). Asking "does this look duplicated?" is not evidence.

#### Proof Checklist

Each finding must include ALL of:

1. **Code evidence** — Exact lines from both duplicate locations
   ```
   Location A: path/to/file.ts, line 42-56
   Location B: path/to/other.ts, line 18-32
   ```
2. **Clone type** — Type 1/2/3/4 with explanation
   ```
   Type 2 (Renamed clone): Same structure, variable names differ
   ```
3. **Why it is harmful** — Maintenance risk, bug-propagation potential
   ```
   bug-propagation risk: fix in one location without fixing the other
   ```
4. **Cross-reference proof** — jscpd output, structural_search match, diff output, or both code snippets
   ```bash
   # jscpd output showing clone pair
   jscpd .pi/extensions/<name>/ --min-lines 5 --min-tokens 50
   ```
   Include the actual tool output or summary in report.
5. **Line count** — Total duplicate lines across all locations
   ```
   Lines: 15 lines × 2 locations = 30 lines total duplication
   ```
6. **Confidence score** — Assign 100/90/70/60% based on type
   ```
   Confidence: 90% — Type 2 clone verified by jscpd and structural_search
   ```

#### False Positive First Aid

Before filing, run through this checklist:

1. **Is it generated code?** — If both blocks are output from the same code generator or template, duplication is expected. Skip.
2. **Is it a legitimate shared abstraction?** — If both blocks are calling the same library function with same args, that's not duplication, that's correct usage. Skip.
3. **Is the duplication trivial?** — Single-line repetitions (e.g. repeated `import` lines, repeated config keys) may not warrant extraction. Minimum threshold: 3+ lines or significant business logic.
4. **Is it a common pattern that TypeScript cannot abstract?** — Some patterns (e.g., type annotations, decorators) cannot be DRY'd up in TypeScript. Skip.
5. **Is there a `// dup` or `// intentional` comment?** — If the developer explicitly acknowledged the duplication, skip.
6. **Is the <10 lines of boilerplate?** — Small boilerplate is often acceptable. File only if >10 lines or high bug-propagation risk.
7. **Are the two blocks actually different in behavior?** — If the two blocks serve different purposes despite structural similarity, skip.
8. **Is the duplicate in test code only?** — Test duplication is lower priority but still valid if it creates maintenance burden. Flag at lower severity.

#### False Positive Scenarios to Skip

```typescript
// FALSE POSITIVE: Generated code — skip
// Both files have identical license headers from a boilerplate generator
// This is expected, not actionable

// FALSE POSITIVE: Calling same library function — skip
// Both files call path.join() with different args
// Not duplication, just using the API correctly

// FALSE POSITIVE: Intentional symmetry — skip
// Two functions that look similar but handle opposite directions
// e.g., encode() and decode() with mirrored logic
```

### Phase 5 — GitHub Issue Creation

Only create issue after proof is complete. Use `gh issue create` via `bash gh`.

#### Issue Template (Clustered Scope)

Each issue covers ALL related clones in a module/file — NOT individual clone pairs.

```
**Extension:** <name>
**Cluster scope:** <scope description, e.g. "All render-loop duplication in session/ and subagent/">
**Clone Types:** <Type 1/2/3/4 — may list multiple>
**Technique:** <technique that found these>
**Confidence:** <60%/70%/90%/100% — per-cluster>
**Severity:** <P0/P1/P2/P3 — highest across cluster>
**Lines:** <total duplicate lines across all locations in cluster>
**Locations:** <N locations across M files>

## Description
<clear description of the clustered duplication pattern, all affected files, and why it matters>

## Proof

### Cluster Overview
| Location | File | Lines | Clone Type | Lines Duplicated |
|----------|------|-------|------------|------------------|
| 1 | path/to/file.ts | N-M | Type 1 | X |
| 2 | path/to/other.ts | N-M | Type 2 | X |
| ... | ... | ... | ... | ... |

### Code Evidence

**Location 1:**
```

File: path/to/file.ts, line N-M
<code snippet>

```

**Location 2:**
```

File: path/to/other.ts, line N-M
<code snippet>

```

<additional locations as needed>

### Clone Type Classification
<Type(s) with explanation>

### Why It Is Harmful
<maintenance risk, bug-propagation potential, cognitive load — cumulative across cluster>

### Cross-Reference Proof
```

<jscpd output, structural_search match, diff output, or other tool proof — per location>

```

### Confidence Assessment
<why this confident, what edge cases ruled out, what tools confirmed>

### Impact
<total lines of duplication across all locations, refactoring complexity, whether single-extraction fix covers all>

## Suggested Fix
<optional: suggested refactoring — ideally one extraction that addresses all locations in the cluster>
```

#### Severity Guide

| Severity | Criteria                                                                     |
| -------- | ---------------------------------------------------------------------------- |
| P0       | Bug-propagation risk (same bug exists in multiple locations)                 |
| P1       | Security duplication (same vulnerability copied across files)                |
| P2       | Significant duplication (15+ lines, 3+ locations, or complex business logic) |
| P3       | Minor duplication (5-15 lines, 2 locations, boilerplate, convenience)        |

#### Issue Creation Command

```bash
# Write body to temp file to avoid shell escaping issues
cat > /tmp/duplicate-code-report-<ext-name>.md << 'EOF'
<body content>
EOF

gh issue create \
  --repo "$(grep -o '"repo"[^,]*' .pi/settings.json | tail -1 | sed 's/.*"repo": *"\([^"]*\)".*/\1/')" \
  --title "Duplicate Code: <ext-name> - <short description>" \
  --label "duplicate-code" \
  --body-file /tmp/duplicate-code-report-<ext-name>.md

# Clean up
rm /tmp/duplicate-code-report-<ext-name>.md
```

Read repo from `.pi/settings.json`:

```bash
grep -o '"repo"[^,]*' .pi/settings.json | tail -1 | sed 's/.*"repo": *"\([^"]*\)".*/\1/'
```

#### Labels

Always add `duplicate-code` label. Add severity label if exists in repo: `severity:high`, `severity:medium`, `severity:low`. If `duplicate-code` label does not exist on repo, use `enhancement` instead.

#### Existing Issues Check

Before creating issue, check if similar duplicate code already reported:

```bash
gh issue list --repo <repo> --label duplicate-code --state open --json title --limit 30 \
  | grep -i "<keyword>"
```

If duplicate found, skip and note which issue. Also check `enhancement` label issues for keywords.

### Phase 6 — Report

After hunt loop completes (either finding filed or all extensions exhausted), output summary:

```
## Duplicate Code Hunt Report

**Extension:** <name>
**Files analyzed:** <count>
**Total lines:** <approximate>
**Techniques applied:** <all 9>
**Tools used:** <jscpd, ripgrep_search, structural_search>

### Findings

| # | Technique | Clone Type | Confidence | Severity | Lines (×locations) | Filed? |
|---|-----------|------------|------------|----------|-------------------|--------|
| 1 | exact-clones | Type 1 | 100% | P2 | 15×2=30 | [#123](url) |
| 2 | near-miss-clones | Type 3 | 70% | P3 | 8×2=16 | [#124](url) |

### Summary
<total findings, total filed, any skips with reason>
```

## Clustering Rules

Group related findings into the same issue. Do NOT file one issue per clone pair.

### Cluster Criteria

Group clones together when ANY of these apply:
1. **Same file** — Multiple clone pairs in the same file → one issue
2. **Same module** — Clone pairs in sibling files of the same module directory (e.g., `pipeline/*.ts`, `checks/*.ts`) → one issue
3. **Same pattern** — Clone pairs with the same code pattern even across modules (e.g., render-loop wrapping in two renderer files) → one issue
4. **Same fix** — Clone pairs that can be eliminated with a single extracted helper → one issue

### When to File Separately

Only split into separate issues if ALL four are true:
1. Different files in completely unrelated modules
2. Different code patterns (not the same root cause)
3. Different fix approach (can't share one helper)
4. Each issue would still meet the minimum impact threshold (≥30 total duplicate lines OR ≥3 locations)

### Minimum Scope Threshold

Each issue must cover at least ONE of:
- ≥30 total duplicate lines across all locations in the issue
- ≥3 clone locations (pairs or triplicates)
- P0/P1 severity (security or live bug risk)

Exception: A single very large clone (≥50 lines, 2 locations, P2+) can be its own issue.

### Cluster Examples

**GOOD — One issue per cluster:**
- Issue 1: "Renderer render-loop duplication" covering 4 clone pairs across 2 renderer files
- Issue 2: "Pipeline boilerplate clones" covering 4 small intra-file clones across 3 pipeline files

**BAD — One issue per pair:**
- Issue 1: "message-renderer.ts task prompt clone" (8 lines)
- Issue 2: "message-renderer.ts thinking render clone" (7 lines)
- Issue 3: "message-renderer.ts raw output clone" (8 lines)

### Sorting Within Cluster

When filing a clustered issue, order locations by clone type priority (Type 1 > Type 2 > Type 3 > Type 4) then by size (largest first). The issue title should describe the scope, not a specific pair.

## Rules

1. **Hunt until found** — Must loop through extensions until one finding filed or all exhausted. Do not stop after first extension if nothing found.
2. **Cluster by scope** — Group related findings into as few issues as possible. See Clustering Rules above.
3. **Deterministic proof for Type 1-2** — jscpd, ripgrep_search, structural_search, or diff must confirm. LLM opinion not acceptable as primary proof for Type 1-2.
4. **No duplicate** — Check existing open issues first
5. **File cleanup** — Delete temp files after issue creation
6. **Track picked extensions** — Maintain list of picked extensions this run. Never re-pick same extension within one invocation.
7. **Clone type priority** — Type 1 > Type 2 > Type 3 > Type 4. Prefer higher type findings.
8. **Triplicate priority** — If 3+ duplicate locations exist, prefer over pair duplicates.
9. **Line count threshold** — Minimum 5 lines or 50 tokens for a duplicate block. Smaller blocks are too noisy.
10. **Boilerplate tolerance** — Skip generated code, license headers, and mandatory file templates. These are expected duplication.
11. **LLM boundary** — LLM may ONLY independently detect Type 4 (semantic) clones. For Type 1-3, LLM may only classify/analyze after a deterministic tool finds the pair. Exception: if no deterministic tool available (e.g., jscpd fails) AND you can manually read and prove the duplication by reading both blocks side-by-side, LLM analysis backed by manual reading is acceptable.
12. **All exhausted = report** — If every extension checked and zero duplicate code found, output full report stating that. No fabricated findings.
13. **Three-way match** — Each finding must have code evidence (2 locations) + clone type + tool proof minimum
14. **Confidence not negotiable** — If you cannot confidently classify a finding, do not file it. Prefer 100% findings over lower confidence ones when multiple options exist.
15. **Sort by impact** — When multiple high-confidence findings exist, file the one with most lines duplicated at most locations. Bigger cleanup = better issue.
16. **Cluster by scope** — Apply Clustering Rules before filing. A single comprehensive issue is better than 5 narrow ones.

## Reference

See [references/duplicate-code-detection.md](references/duplicate-code-detection.md) for detailed clone type descriptions, advanced detection strategies, and refactoring guidance.
