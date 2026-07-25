---
description: Scan target code for complexity patterns — deep nesting, dead code, unnecessary abstractions, naming issues. File umbrella GitHub issue with simplification candidates and per-candidate sub-issues with examples.
---

# Code Simplification — Analyze & Simplify Code Complexity

Find complexity patterns in a target codebase, file an **umbrella GitHub issue** cataloging each candidate, plus one **sub-issue per candidate** with the before/after diff, principle violated, and verification steps.

Requires: `gh` CLI authenticated.

## Usage

```
/code-simplification <target>
```

| Target              | What it analyzes                                |
| ------------------- | ----------------------------------------------- |
| `root` (or omitted) | Main repo                                       |
| `<submodule-name>`  | Submodule by name (resolved from `.gitmodules`) |
| `<any-path>`        | Arbitrary directory                             |

## Workflow

### 1 — Resolve target

Extract target from message:

- `/code-simplification <target>` → use directly
- Natural language: parse "of X", "in X", "for X", or single word matching submodule name or valid path
- If nothing matches, treat as `root`

Read `.gitmodules` from project root. Parse submodules. If target matches submodule name, resolve to its `path`. Otherwise treat as relative directory. For `root`, use `.`.

### 2 — Explore codebase for complexity patterns

Walk target with Pi tools **in this order**. Skipping `structural_search` and going straight to `read` produces a shallow scan, not a simplification audit.

1. **`structural_search` — MANDATORY first pass.** Run these AST patterns before `read`ing any file:
   - Deep nesting — `if ($A) { if ($B) { $$$BODY } }`. Hunt 3+ level nesting.
   - Boolean parameter flags — `function $NAME($A: boolean, $B: boolean)` or similar. Flag callers for readability.
   - Nested ternaries — `$A ? $B : $C ? $D : $E`. Replace with if/else or lookup.
   - Dead code islands — `function $NAME($$$ARGS) { $$$BODY }` then `ripgrep_search $NAME` across target. Zero external importers = dead.
   - Pass-through wrappers — `function $NAME($ARG) { return $INNER($ARG) }` where body only delegates.
   - Re-export barrels — `export { $$$NAMES } from "$SRC"`. Check if callers reach past the barrel.
   - Redundant async — `async function $NAME($$$ARGS) { return await $INNER($$$ARGS) }`. Drop `async`/`await`.
   - Factory-of-one — `function create$NAME` / `function make$NAME`. One product, no polymorphism = speculative abstraction.

2. **`ripgrep_search` — import counts and dead-island confirmation.** For every suspicious symbol surfaced above, grep the bare name across the whole target. Count importers by file. The decisive test: **symbol referenced only by its own file + test files = dead island.** Also grep for:
   - `// TODO` / `// FIXME` / `// HACK` — high-concentration files are simplification targets
   - `any` type usage — indicator of insufficient types
   - `// eslint-disable-next-line` / `// ts-expect-error` — suppression clusters signal complexity
   - Boolean parameters in function calls — `func(true, false)` patterns

3. **`read` — inspect files last.** Only after steps 1-2 have named concrete suspects. Read the function, not the whole file. Use `offset` and `limit` to target specific functions.

4. **`bash` — verify scale.** `wc -l` on suspect files. Files over 300 lines are structural candidates.

**Chesterton's Fence:** Before flagging anything as dead or unnecessary, check `git blame` for context. The code may exist for a reason you don't see yet. Note the original commit message in the issue.

### 2.5 — Evidence rule

Every claim in an issue body must cite tool output, not assertion. "`deep` function has 0 external callers" is a claim; back it with the `ripgrep_search` result. "Nested ternary at line 142" must include the exact line. A candidate filed without evidence is a guess — mark it `[Speculative]` at most or drop it.

### 2.6 — Stop rule

Stop exploring once you hold 3-7 candidates with tool evidence. Over-exploring past that turns simplification into a rewrite proposal; this is a triage surface, not an exhaustive refactor. Suspects that fail the evidence rule do not count toward the 3-7.

### 3 — Create umbrella issue

Create one GitHub issue listing 3-7 simplification candidates.

**Strength rule (evidence-gated):**

- **[Strong]** — tool evidence is solid AND Chesterton's Fence check done (no hidden reason). File a sub-issue.
- **[Speculative]** — real signal but unclear if simplification is safe (ambiguous `git blame`, or incomplete tool evidence). File a sub-issue only if ≤2 [Strong].
- Drop silently — no evidence or Chesterton's Fence reveals the complexity is intentional.

File at most 7 candidates total across both strengths; 2-4 strong is a healthy review.

**Title:** `Code Simplification: <target-name> — <YYYY-MM-DD>`

**Labels:** Always `simplification`. If target is a submodule, also add submodule name as label (create with `gh label create <name>` if absent).

**Body structure:**

````markdown
## Candidates

### 1. <short title> [Strong]

**Files:** `path/to/file.ts`
**Pattern:** <pattern from Step 2>

**Before:**
```typescript
const label = isNew ? 'New' : isUpdated ? 'Updated' : 'Archived';
```

**After:**
```typescript
function getStatusLabel(item: Item): string {
  if (item.isNew) return 'New';
  if (item.isUpdated) return 'Updated';
  return 'Archived';
}
```

**Wins:** Bullets (≤6 words each).
**Evidence:** <cite exact tool output>

---

### 2. <short title> [Speculative]

...

## Top Recommendation

**<candidate name>** — one sentence why.

## Summary

| Candidate | Pattern | Principle | Lines changed | Risk |
|-----------|---------|-----------|---------------|------|
| 1         | Nested ternary | Clarity > Cleverness | -5+2 | Low |
| 2         | Dead code | Redundancy | -30 | Low |
...

````

### 4 — Create sub-issues

Per candidate, create a **proper GitHub sub-issue** linked to the umbrella — not a standalone issue with a cross-reference comment. GitHub's sub-issue relationship is set at create time with `--parent`; it cannot be added by a comment later.

Create the umbrella issue first (Step 3) and **capture its issue number** (printed in `gh issue create` output). Then create each sub-issue anchored to that parent:

```
gh issue create \
  --title "SIMPLIFY: <candidate short title>" \
  --label simplification[,<submodule-name>] \
  --body-file <body-file> \
  --parent <umbrella-number>
```

The `--parent <number>` flag is the **only** mechanism that produces a real sub-issue in GitHub's issue hierarchy. Cross-reference comments and body mentions do **not** create the parent-child link — issues filed that way are independent issues that merely mention each other, which is exactly the bug we are fixing here.

Sub-issue fields:
- **Title:** `SIMPLIFY: <candidate short title>`
- **Body:**
  ````
  Part of **Code Simplification: <target-name>** (#N)

  **Pattern:** <nested ternary / dead code / ...>
  **Principle violated:** Clarity Over Cleverness / Redundancy / ...
  **Evidence:** <tool output>

  **Before:**
  ```typescript
  ...
  ```

  **After:**
  ```typescript
  ...
  ```

  **Verification:**
  - [ ] All tests pass without modification
  - [ ] Build succeeds with no new warnings
  - [ ] Linter/formatter passes
  - [ ] Error behavior preserved
  - [ ] Teammate would approve as net improvement
  ````
- **Labels:** same as umbrella (`simplification` + submodule name)
- The body opens with `Part of **Code Simplification: <target-name>** (#N)` (informational only; the real parent link is set by `--parent`, not this line).

### 5 — Board, complete

1. Add umbrella and all sub-issues to project board with status `Research` (use `gh project item-edit` or GraphQL). The parent-child hierarchy is already rendered in the GitHub UI via `--parent`; **do not** also post a comment table — that duplicates the native sub-issue list.
2. Print all issue URLs

> Simplification analysis filed. Umbrella: **#N**. Sub-issues: **#A**, **#B**. Apply with `/supervisor <number>` on any candidate.

## The Five Principles (from addyosmani/agent-skills)

### 1. Preserve Behavior Exactly

Don't change what the code does — only how it expresses it. All inputs, outputs, side effects, error behavior, and edge cases must remain identical. If you're not sure a simplification preserves behavior, don't make it.

```
ASK BEFORE EVERY CHANGE:
→ Does this produce the same output for every input?
→ Does this maintain the same error behavior?
→ Does this preserve the same side effects and ordering?
→ Do all existing tests still pass without modification?
```

### 2. Follow Project Conventions

Simplification means making code more consistent with the codebase, not imposing external preferences. Before simplifying:

```
1. Read CLAUDE.md / project conventions
2. Study how neighboring code handles similar patterns
3. Match the project's style for:
   - Import ordering and module system
   - Function declaration style
   - Naming conventions
   - Error handling patterns
   - Type annotation depth
```

Simplification that breaks project consistency is not simplification — it's churn.

### 3. Prefer Clarity Over Cleverness

Explicit code is better than compact code when the compact version requires a mental pause to parse.

```typescript
// UNCLEAR: Dense ternary chain
const label = isNew ? 'New' : isUpdated ? 'Updated' : isArchived ? 'Archived' : 'Active';

// CLEAR: Readable mapping
function getStatusLabel(item: Item): string {
  if (item.isNew) return 'New';
  if (item.isUpdated) return 'Updated';
  if (item.isArchived) return 'Archived';
  return 'Active';
}
```

```typescript
// UNCLEAR: Chained reduces with inline logic
const result = items.reduce((acc, item) => ({
  ...acc,
  [item.id]: { ...acc[item.id], count: (acc[item.id]?.count ?? 0) + 1 }
}), {});

// CLEAR: Named intermediate step
const countById = new Map<string, number>();
for (const item of items) {
  countById.set(item.id, (countById.get(item.id) ?? 0) + 1);
}
```

### 4. Maintain Balance

Simplification has a failure mode: over-simplification. Watch for these traps:

- **Inlining too aggressively** — removing a helper that gave a concept a name makes the call site harder to read
- **Combining unrelated logic** — two simple functions merged into one complex function is not simpler
- **Removing "unnecessary" abstraction** — some abstractions exist for extensibility or testability, not complexity
- **Optimizing for line count** — fewer lines is not the goal; easier comprehension is

### 5. Scope to What Changed

Default to simplifying recently modified code. Avoid drive-by refactors of unrelated code unless explicitly asked to broaden scope. Unscoped simplification creates noise in diffs and risks unintended regressions.

## Simplification Patterns

### Structural complexity

| Pattern | Signal | Simplification |
|---------|--------|----------------|
| Deep nesting (3+ levels) | Hard to follow control flow | Extract conditions into guard clauses or helper functions |
| Long functions (50+ lines) | Multiple responsibilities | Split into focused functions with descriptive names |
| Nested ternaries | Requires mental stack to parse | Replace with if/else chains, switch, or lookup objects |
| Boolean parameter flags | `doThing(true, false, true)` | Replace with options objects or separate functions |
| Repeated conditionals | Same `if` check in multiple places | Extract to a well-named predicate function |
| Unnecessary async/await | `async` wrapping a sync call | Drop `async`/`await`, return promise directly |

### Naming and readability

| Pattern | Signal | Simplification |
|---------|--------|----------------|
| Generic names | `data`, `result`, `temp`, `val`, `item` | Rename to describe content: `userProfile`, `validationErrors` |
| Abbreviated names | `usr`, `cfg`, `btn`, `evt` | Use full words unless universal (`id`, `url`, `api`) |
| Misleading names | Function named `get` that also mutates | Rename to reflect actual behavior |
| Comments explaining "what" | `// increment counter` above `count++` | Delete the comment |
| Comments explaining "why" | `// Retry because API is flaky` | Keep these — intent code can't express |

### Redundancy

| Pattern | Signal | Simplification |
|---------|--------|----------------|
| Duplicated logic | Same 5+ lines in multiple places | Extract to a shared function |
| Dead code | Unreachable branches, unused variables, commented-out blocks | Remove (after confirming truly dead) |
| Unnecessary abstractions | Wrapper adding no value | Inline, call underlying function directly |
| Over-engineered patterns | Factory-for-a-factory, strategy-with-one-strategy | Replace with direct approach |
| Redundant type assertions | Casting to already-inferred type | Remove the assertion |
| Pass-through wrappers | Function that only delegates | Delete, update callers |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It's working, no need to touch it" | Working code that's hard to read will be hard to fix when it breaks. Simplifying now saves time on every future change. |
| "Fewer lines is always simpler" | A 1-line nested ternary is not simpler than a 5-line if/else. Simplicity is about comprehension speed, not line count. |
| "I'll just quickly simplify this unrelated code too" | Unscoped simplification creates noisy diffs and risks regressions in code you didn't intend to change. Stay focused. |
| "The types make it self-documenting" | Types document structure, not intent. A well-named function explains *why* better than a type signature explains *what*. |
| "This abstraction might be useful later" | Don't preserve speculative abstractions. If not used now, it's complexity without value. Remove it and re-add when needed. |
| "The original author must have had a reason" | Maybe. Check git blame — apply Chesterton's Fence. But accumulated complexity often has no reason; it's residue of iteration under pressure. |
| "I'll refactor while adding this feature" | Separate refactoring from feature work. Mixed changes are harder to review, revert, and understand in history. |

## Red Flags

- Simplification that requires modifying tests to pass (you likely changed behavior)
- "Simplified" code that is longer and harder to follow than the original
- Renaming things to match your preferences rather than project conventions
- Removing error handling because "it makes the code cleaner"
- Simplifying code you don't fully understand
- Batching many simplifications into one large, hard-to-review commit
- Refactoring code outside the scope of the current task without being asked

## Verification

After completing a simplification pass:

- [ ] All existing tests pass without modification
- [ ] Build succeeds with no new warnings
- [ ] Linter/formatter passes (no style regressions)
- [ ] Each simplification is a reviewable, incremental change
- [ ] The diff is clean — no unrelated changes mixed in
- [ ] Simplified code follows project conventions (checked against CLAUDE.md or equivalent)
- [ ] No error handling was removed or weakened
- [ ] No dead code was left behind (unused imports, unreachable branches)
- [ ] A teammate or review agent would approve the change as a net improvement

## Tone

Lean editorial. No hedging, no throat-clearing. Sentence → bullet if possible. Bullet → cut if possible. Every simplification recommendation must cite the specific pattern from the table above.
