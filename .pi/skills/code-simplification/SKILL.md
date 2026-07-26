---
name: code-simplification
description: Scan target code for complexity patterns — deep nesting, dead code, unnecessary abstractions, naming issues. File umbrella GitHub issue with simplification candidates and per-candidate sub-issues with examples.
disable-model-invocation: true
---

# Code Simplification — Analyze & Simplify Code Complexity

Find complexity patterns in a target codebase, file an **umbrella GitHub issue** cataloging each candidate, plus one **sub-issue per candidate** with the before/after diff, principle violated, and verification steps.

Requires: `gh` CLI authenticated.

## Usage

```
/skill:code-simplification <target>
```

| Target              | What it analyzes                                |
| ------------------- | ----------------------------------------------- |
| `root` (or omitted) | Main repo                                       |
| `<submodule-name>`  | Submodule by name (resolved from `.gitmodules`) |
| `<any-path>`        | Arbitrary directory                             |

## Workflow

### 1 — Resolve target

Extract target from message:

- `/skill:code-simplification <target>` → use directly
- Natural language: parse "of X", "in X", "for X", or single word matching submodule name or valid path
- If nothing matches, treat as `root`

Read `.gitmodules` from project root. Parse submodules. If target matches submodule name, resolve to its `path`. Otherwise treat as relative directory. For `root`, use `.`.

### 2 — Explore codebase for complexity patterns

Walk target with Pi tools **in this order**. Skipping `structural_search` and going straight to `read` produces a shallow scan, not a simplification audit.

1. **`structural_search` — MANDATORY first pass.** Run these AST patterns before `read`ing any file:
   - Deep nesting — `if ($A) { if ($B) { $$$BODY } }`. Hunt 3+ level nesting.
   - Boolean parameter flags — `function $NAME($A: boolean, $B: boolean)` or similar.
   - Nested ternaries — `$A ? $B : $C ? $D : $E`.
   - Dead code islands — `function $NAME($$$ARGS) { $$$BODY }` then `ripgrep_search $NAME`.
   - Pass-through wrappers — `function $NAME($ARG) { return $INNER($ARG) }`.
   - Re-export barrels — `export { $$$NAMES } from "$SRC"`.
   - Redundant async — `async function $NAME($$$ARGS) { return await $INNER($$$ARGS) }`.
   - Factory-of-one — `function create$NAME` / `function make$NAME`.

2. **`ripgrep_search`** — import counts, dead-island confirmation, TODO/FIXME/HACK clusters, `any` types, suppression comments, boolean parameter calls.

3. **`read`** — inspect files last.

4. **`bash`** — `wc -l` on suspect files.

### 2.5 — Evidence rule

Every claim must cite tool output, not assertion.

### 2.6 — Stop rule

Stop at 3-7 candidates.

### 3 — Create umbrella issue

**Strength rule:** [Strong] = tool evidence + Chesterton's Fence done. [Speculative] = unclear. Drop = no evidence.

**Title:** `Code Simplification: <target-name> — <YYYY-MM-DD>`

**Labels:** `simplification`

### 4 — Create sub-issues

Use `gh issue create --parent <umbrella-number>`.

### 5 — Board, complete

## The Five Principles

### 1. Preserve Behavior Exactly
### 2. Follow Project Conventions
### 3. Prefer Clarity Over Cleverness
### 4. Maintain Balance
### 5. Scope to What Changed

## Simplification Patterns

### Structural complexity
| Pattern | Signal | Simplification |
|---------|--------|----------------|
| Deep nesting (3+ levels) | Hard to follow | Guard clauses or helper functions |
| Long functions (50+ lines) | Multiple responsibilities | Split into focused functions |
| Nested ternaries | Mental stack | if/else chains or lookup objects |
| Boolean parameter flags | `doThing(true, false)` | Options objects or separate functions |
| Repeated conditionals | Same check in multiple places | Predicate function |
| Unnecessary async/await | Wrapping sync call | Drop async/await |

### Naming and readability
| Pattern | Signal | Simplification |
|---------|--------|----------------|
| Generic names | `data`, `result`, `temp` | Describe content |
| Abbreviated names | `usr`, `cfg` | Full words |
| Misleading names | `get` that mutates | Rename |
| "What" comments | `// increment counter` | Delete |

### Redundancy
| Pattern | Simplification |
|---------|----------------|
| Duplicated logic | Shared function |
| Dead code | Remove |
| Unnecessary abstractions | Inline |
| Over-engineered patterns | Direct approach |
| Redundant type assertions | Remove |
| Pass-through wrappers | Delete, update callers |

## Tone

Lean editorial. No hedging, no throat-clearing. Sentence → bullet if possible. Bullet → cut if possible.
