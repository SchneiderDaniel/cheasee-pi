# Duplicate Code Detection Techniques — Clone Types & Search Strategies

Detailed pattern catalog for each clone type and detection technique. Use as reference during Phase 3.

**Deterministic-first principle:** Every pattern below prioritizes deterministic detection. Use `jscpd` for token-based scanning, `ripgrep_search` for literal pattern matching, `structural_search` for AST-level matching, and `diff` for pairwise comparison. Never ask the LLM "is this duplicated?" for Type 1-2 clones — that is speculation.

---

## 1. Clone Type Deep Dive

### Type 1 — Exact Clone

**Definition:** Code fragments that are identical except for variations in whitespace, formatting, layout, and comments.

**Characteristics:**

- 100% token sequence match after normalization
- Identical or nearly identical abstract syntax tree (AST)
- Only syntactically insignificant differences (spaces, line breaks, indentation, comment text)
- Also called "copy-paste clones"

**Detection approaches:**

- **String-based:** Normalize whitespace and compare raw text line by line
- **Token-based:** Parse into tokens, normalize whitespace/newlines, compare token sequences
- **AST-based:** Compare parsed ASTs node by node

**Typical causes:**

- Copy-paste with no modification
- LLM-generated boilerplate repeated verbatim
- Generated code from same template
- Accidental file duplication (same file copied to new name)

### Type 2 — Renamed Clone

**Definition:** Code fragments that are structurally identical but differ in identifier names (variable names, function names, type names) and/or literal values.

**Characteristics:**

- Same AST structure but leaf nodes (identifiers, literals) differ
- Same statement order and nesting depth
- Same control flow structure
- Parameter count matches

**Detection approaches:**

- **Token-based with normalization:** Replace all identifiers with a placeholder token (e.g., `$ID`) and all literals with `$LIT`, then compare
- **AST-based:** Compare AST structure ignoring identifier/literal leaf values
- **Parameterized matching:** Extract structure with meta-variables

**Typical causes:**

- Copy-paste with find-and-replace (variable renaming)
- Template-based code generation with different inputs
- Parallel implementations that should share a function

### Type 3 — Near-Miss Clone

**Definition:** Code fragments that have similar structure but with added, modified, or removed statements. The overall shape is preserved but details differ.

**Characteristics:**

- > 60% structural similarity
- Some statements added/removed/modified
- Same overall flow but different intermediate steps
- Similar entry/exit points but different internals

**Detection approaches:**

- **Token-based with threshold:** Allow N% token mismatch (e.g., jscpd --threshold 15)
- **Line alignment:** Compare lines pairwise, count matches vs differences
- **AST edit distance:** Measure minimum AST transformations to convert one block to another

**Typical causes:**

- Copy-paste with modifications (added error handling, changed input format)
- Forked code that diverged slightly
- Independent implementations of similar algorithm

### Type 4 — Semantic Clone

**Definition:** Code fragments that implement the same functionality using different syntax, algorithms, or data structures.

**Characteristics:**

- Different AST structure
- Different statement sequence
- Same functional behavior
- Different API/library usage to achieve same goal

**Detection approaches:**

- **LLM-assisted:** Read code and reason about functional equivalence
- **Input-output analysis:** Compare results for same test inputs
- **Documentation comparison:** Compare docstrings/descriptions

**Typical causes:**

- Multiple implementations of same business rule
- Reimplemented library function
- Different team members solving same problem differently

---

## 2. Detection Strategy Reference

### 2a. jscpd Usage

```bash
# Basic scan — exact + renamed clones (Type 1-2)
jscpd /path/to/target/ --min-lines 5 --min-tokens 50 --output json

# Near-miss tolerant (Type 3 with threshold)
jscpd /path/to/target/ --min-lines 5 --min-tokens 30 --threshold 15 --output json

# Aggressive — find small clones too
jscpd /path/to/target/ --min-lines 3 --min-tokens 20 --output json

# Exclude patterns
jscpd /path/to/target/ --min-lines 5 --min-tokens 50 --output json \
  --exclude "**/*.test.ts" --exclude "**/node_modules/**"

# Use with pipe for JSON parsing
jscpd /path/to/target/ --min-lines 5 --min-tokens 50 --output json \
  | python3 -m json.tool  # pretty print
```

**jscpd output structure:**

```json
{
	"statistics": {
		"detectionDate": "2026-05-27T...",
		"formats": {
			"typescript": {
				"total": { "lines": 500, "tokens": 2000, "sources": 10 },
				"clones": 5,
				"duplicatedLines": 120,
				"duplicatedTokens": 480,
				"percentage": 24.0
			}
		}
	},
	"duplicates": [
		{
			"format": "typescript",
			"fragment": "const ... = ...",
			"lines": 15,
			"tokens": 60,
			"firstFile": { "name": "/path/to/file.ts", "start": 42, "end": 57 },
			"secondFile": { "name": "/path/to/other.ts", "start": 18, "end": 33 }
		}
	]
}
```

### 2b. ripgrep_search for Duplicate Detection

```bash
# Method 1: Search for a distinctive line from suspected duplicate block
ripgrep_search "distinctive code string" .pi/extensions/<name>/

# Method 2: Search for a multi-line pattern (use a unique terminating line)
ripgrep_search "if (!data || typeof data !== \"object\")" .pi/extensions/<name>/

# Method 3: Count occurrences of specific patterns to gauge repetition
ripgrep_search "return path.join" .pi/extensions/<name>/
# High count of same prefix indicates repeated path-building

# Method 4: Find duplicate import patterns
ripgrep_search "from \"../types\"" .pi/extensions/<name>/
# Multiple files importing from same module with overlapping specifiers
```

### 2c. structural_search for Duplicate Detection

```bash
# Find all functions with identical parameter+body shape
structural_search "function $NAME($PARAMS) { $$$BODY }" ts

# Find all if/else-if chains (compare across files)
structural_search "if ($COND) $$$THEN else if ($OTHER) $$$ELSE" ts

# Find all try/catch blocks with similar patterns
structural_search "try { $$$TRY } catch ($ERR) { $$$CATCH }" ts

# Find switch/case blocks
structural_search "switch ($VALUE) { $$$CASES }" ts

# Compare by counting — many similar AST structures indicate duplication
```

### 2d. Manual Pairwise Comparison

```bash
# Step 1: Extract blocks to temp files
read .pi/extensions/<name>/file.ts --offset 100 --limit 20 \
  > /tmp/blockA.ts
read .pi/extensions/<name>/other.ts --offset 50 --limit 20 \
  > /tmp/blockB.ts

# Step 2: Diff them
diff /tmp/blockA.ts /tmp/blockB.ts

# Step 3: Normalize identifiers for Type 2 detection
sed -E 's/\b[a-zA-Z_][a-zA-Z0-9_]*\b/ID/g' /tmp/blockA.ts > /tmp/blockA.norm
sed -E 's/\b[a-zA-Z_][a-zA-Z0-9_]*\b/ID/g' /tmp/blockB.ts > /tmp/blockB.norm
diff /tmp/blockA.norm /tmp/blockB.norm

# Step 4: Side-by-side diff for visual comparison
diff --side-by-sid e --width=160 /tmp/blockA.ts /tmp/blockB.ts

# Clean up temp files
rm /tmp/blockA.ts /tmp/blockB.ts /tmp/blockA.norm /tmp/blockB.norm
```

**diff exit codes:**

- `0` — files are identical (Type 1 if before normalization, Type 2 if after normalization)
- `1` — files differ
- `2` — error

### 2e. Similarity Scoring

For borderline cases (Type 2 vs 3), calculate similarity score:

```bash
# Count matching lines using diff
diff /tmp/blockA.norm /tmp/blockB.norm 2>&1 | grep -c '^[<>]'   # changed lines
diff /tmp/blockA.norm /tmp/blockB.norm 2>&1 | grep -c '^[[:space:]]'  # unchanged lines

# Similarity = unchanged / total_lines
# >90% identical lines → Type 2
# 60-90% identical lines → Type 3
# <60% identical lines → not a clone (or Type 4 semantic)
```

---

## 3. Common Duplicate Code Patterns in Pi Extensions

### Pattern A: Tool Registration Boilerplate

```typescript
// DUPLICATED across multiple extension files
const MyTool: Tool = {
	name: "my-tool",
	description: "Does something",
	params: t.Object({
		input: t.String({ description: "The input" }),
		output: t.Optional(t.String({ description: "Output format" })),
	}),
};
// Same structure repeated for each tool with only name/desc changing
```

### Pattern B: File I/O Wrappers

```typescript
// DUPLICATED — same read/write pattern in multiple files
async function readConfig(path: string) {
	try {
		const content = await fs.readFile(path, "utf-8");
		return JSON.parse(content);
	} catch (err) {
		throw new Error(`Failed to read config: ${err.message}`);
	}
}

async function readState(path: string) {
	try {
		const content = await fs.readFile(path, "utf-8");
		return JSON.parse(content);
	} catch (err) {
		throw new Error(`Failed to read state: ${err.message}`);
	}
}
```

### Pattern C: Validation Blocks

```typescript
// DUPLICATED — same validation at start of each tool handler
if (!params.input || typeof params.input !== "string") {
	return { content: [{ type: "text", text: "Error: input required" }] };
}
if (params.input.length > 10000) {
	return { content: [{ type: "text", text: "Error: input too long" }] };
}
```

### Pattern D: Error Handling Wrappers

```typescript
// DUPLICATED — same try/catch/report pattern
try {
	const result = await someOperation(params);
	return { content: [{ type: "text", text: JSON.stringify(result) }] };
} catch (err) {
	return {
		content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
	};
}
```

### Pattern E: Pipeline / Chain Steps

```typescript
// DUPLICATED — same pipe/chain pattern
const intermediate = await step1(params);
const processed = await step2(intermediate);
const final = await step3(processed);
return final;
```

### Pattern F: Type/Schema Definitions

```typescript
// DUPLICATED — same TypeBox schema defined in multiple files
const ToolInput = t.Object({
	path: t.String({ description: "File path" }),
	content: t.String({ description: "File content" }),
});
// Same schema defined in 2+ files instead of shared
```

---

## 4. Refactoring Guidance

### Extract Function / Shared Helper

```typescript
// BEFORE — Duplicated 3 times
function getErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// AFTER — Shared helper in common module
// utils.ts
export function getErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
```

### Merge Conditional Chains

```typescript
// BEFORE — Two places check same role conditions
function getAccessLevel(role: string): string {
	/* ... */
}
function getPermissions(role: string): string[] {
	/* ... */
}

// AFTER — Consolidated into one data-driven lookup
const ROLE_CONFIG = {
	admin: { level: "full", permissions: ["r", "w", "x"] },
	editor: { level: "limited", permissions: ["r", "w"] },
	viewer: { level: "read", permissions: ["r"] },
} as const;
```

### Parameterize Duplicate Logic

```typescript
// BEFORE — Two nearly identical functions
async function createRecord(data: Data) {
	/* insert */
}
async function updateRecord(data: Data) {
	/* update */
}

// AFTER — Parameterized function
async function upsertRecord(data: Data, mode: "create" | "update") {
	const operation = mode === "create" ? db.insert : db.update;
	return operation(data);
}
```

### Replace Repetitive Tool Registration with Factory

```typescript
// BEFORE — Each tool registered individually
pi.registerTool({ name: "tool-a", description: "...", ... });
pi.registerTool({ name: "tool-b", description: "...", ... });
pi.registerTool({ name: "tool-c", description: "...", ... });

// AFTER — Factory function
function registerTool(name: string, description: string, handler: ToolHandler) {
  pi.registerTool({ name, description, params: t.Object({ ... }), handler });
}
```

---

## 5. Impact Assessment

| Factor               | Low Impact                  | Medium Impact                     | High Impact                                 |
| -------------------- | --------------------------- | --------------------------------- | ------------------------------------------- |
| Lines duplicated     | 5-10                        | 11-30                             | 30+                                         |
| Locations            | 2                           | 3-4                               | 5+                                          |
| Logic complexity     | Simple (validation, typing) | Moderate (control flow)           | Complex (business logic, I/O)               |
| Bug-propagation risk | Low (unlikely to change)    | Medium (may change independently) | High (bug fix in one copy missed in others) |
| Cross-module impact  | Same file                   | Same module, different files      | Different modules entirely                  |

---

## 6. False Positive Quick Reference

| Situation                                                                     | Action                         |
| ----------------------------------------------------------------------------- | ------------------------------ |
| Generated code (templates, scaffolds)                                         | Skip                           |
| Mandatory boilerplate (license headers, TypeBox schema with different fields) | Skip                           |
| Calling same library method with same args (legitimate usage)                 | Skip                           |
| Intentional symmetry (encode/decode, serialize/deserialize)                   | Consider skipping              |
| `// dup` or `// intentional` comments                                         | Skip                           |
| Test code only (lower priority, still valid)                                  | Flag at P3                     |
| Single-line repetition                                                        | Skip (too noisy)               |
| Generated by LLM as independent outputs                                       | Flag — high risk of divergence |
