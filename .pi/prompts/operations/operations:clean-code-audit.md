---
description: Scan target code for two grounded violations — oversized files/functions (SonarQube S104, Clean Code) and "what" comments that restate the code. File umbrella GitHub issue with audit candidates plus per-candidate sub-issues with before/after diff and cited source.
---

# Clean Code Audit — File Size & Self-Documenting Code

Find two classes of violation in a target codebase: files and functions that exceed published size ceilings, and comments that explain _what_ the code does instead of _why_ it was written that way. File an **umbrella GitHub issue** cataloging each candidate, plus one **sub-issue per candidate** with the before/after diff, the rule violated, the source authority, and the verification steps.

Requires: `gh` CLI authenticated.

## Usage

```
/clean-code-audit <target>
```

| Target              | What it analyzes                                |
| ------------------- | ----------------------------------------------- |
| `root` (or omitted) | Main repo                                       |
| `<submodule-name>`  | Submodule by name (resolved from `.gitmodules`) |
| `<any-path>`        | Arbitrary directory                             |

## Workflow

### 1 — Resolve target

Extract target from message:

- `/clean-code-audit <target>` → use directly
- Natural language: parse "of X", "in X", "for X", or single word matching submodule name or valid path
- If nothing matches, treat as `root`

Read `.gitmodules` from project root. Parse submodules. If target matches submodule name, resolve to its `path`. Otherwise treat as relative directory. For `root`, use `.`.

### 2 — Explore codebase for violations

Walk target with Pi tools **in this order**. Skipping `structural_search` and going straight to `read` produces a shallow scan, not an audit.

1. **`bash` — MANDATORY first pass for size.** Size is a line-count property, not an AST property; measure it before reasoning about it.
   - `wc -l` every source file under target.inventory any file whose non-blank, non-comment line count crosses a threshold.
   - `git ls-files '<target>/**/*.{ts,js,tsx,py,go,rs,java}' | xargs wc -l | sort -rn | head -40` ranks the largest files.
   - Thresholds (Rule 1):
     ```
     > 500 non-blank, non-comment lines → warn + split candidate
     > 1000 non-blank, non-comment lines → block (refactor before proceeding)
     function length  > 50 lines         → warn
     function length  > 100 lines        → block
     indentation      > 3 levels         → refactor candidate
     column width     > 100 chars        → wrap candidate (80 if project follows Linux/kernel or Google TS)
     ```
   - Skip silently: `node_modules/`, `vendor/`, `third_party/`, `dist/`, lockfiles, generated `.pb.ts`, `.d.ts` emitted by tooling, and any file with a generated-code header. These are not authored by hand; bulk is not a finding.

2. **`structural_search` — MANDATORY second pass for function length and comment shape.** Run these AST patterns before `read`ing any file:
   - Long functions — `function $NAME($$$ARGS) { $$$BODY }` and the method/arrow variants. For each match, compare the body span to the 50/100 line thresholds. A 120-line function is a [Strong] sub-issue on its own.
   - Deep nesting — `if ($A) { if ($B) { if ($C) { $$$BODY } } }`. Hunt 3+ level nesting; this is a Rule 1 (indentation) candidate and usually a Rule 2 (comment) generator.
   - Comment-clad blocks — `// $COMMENT` immediately preceding a single statement. Not every leading comment is a "what" comment, but every "what" comment is a leading comment on a single statement. This pattern narrows the grep in step 3.
   - Re-export barrels that only re-exist to split a large file honestly — `export { $$$NAMES } from "$SRC"`. Not a violation, but confirms a split already happened; note it as prior art for the split strategy.

3. **`ripgrep_search` — "what" comment detection (Rule 2).** A "what" comment restates the mechanism the code already expresses. Grep for the common verb-first restating patterns across the target:
   - `// (get|set|increment|decrement|loop|iterate|check|return|update|create|delete|add|remove|fetch|parse|validate|assign|init|reset|print|log|call|invoke|if|when|for|while)\b` — case-insensitive, anchored to comment markers `//`, `#`, `/*`, `--`, `;;`.
   - Then for each hit, read the **next statement**. If the comment's verb is the same verb the code performs, it is a "what" comment. `// increment counter` above `count += 1` is the textbook case.
   - Distinguish from allowed comments (do not flag these):
     - `// TODO` / `// FIXME` / `// HACK` / `// XXX` / `ponytail:` — these record deferred decisions, i.e. "why".
     - JSDoc / docstrings on public APIs — these document the contract, not the mechanism.
     - Regex explanations, legal headers, license blocks.
     - `// because …` / `// AWS SDK returns null …` / `// tracked in …` — these state a reason the code cannot state itself.

4. **`read` — inspect the violation last.** Only after steps 1–3 have named concrete suspects with line numbers. Read the function, not the whole file. Use `offset` and `limit` to target the exact lines.

### 2.5 — Evidence rule

Every claim in an issue body must cite tool output, not assertion. "`output.ts` is 812 lines" is a claim; back it with the `wc -l` output. "`// increment counter` at line 73 is a what-comment" is a claim; include the exact line and the line below it. A candidate filed without evidence is a guess — mark it `[Worth exploring]` at most, or drop it.

### 2.6 — Stop rule

Stop exploring once you hold 3–7 candidates with tool evidence. Over-exploring past that turns the audit into a rewrite proposal; this is a triage surface, not an exhaustive refactor. Suspects that fail the evidence rule do not count toward the 3–7.

### 3 — Create umbrella issue

Create one GitHub issue listing 3–7 audit candidates.

**Strength rule (evidence-gated):**

- **[Strong]** — tool evidence is solid (exact line counts, exact comment + following line) AND the refactor preserves behaviour identically. File a sub-issue.
- **[Worth exploring]** — real signal but the safe refactor is unclear (the "what" comment sits on side-effecting code, or the file split has non-obvious boundary). File a sub-issue only if ≤2 [Strong].
- Drop silently — no evidence, or the comment turns out to be a "why" comment on second reading.

File at most 7 candidates total across both strengths; 2–4 strong is a healthy review.

**Title:** `Clean Code Audit: <target-name> — <YYYY-MM-DD>`

**Labels:** Always `clean-code`. If target is a submodule, also add submodule name as label (create with `gh label create <name>` if absent).

**Body structure:**

````markdown
## Candidates

### 1. <short title> [Strong]

**Files:** `path/to/file.ts`
**Rule:** Rule 1 (file size) / Rule 2 (self-documenting code)
**Source:** SonarQube S104 / Clean Code ch. 4 / Linux kernel coding style §1 / …

**Before:**
```typescript
// 812 non-blank lines in output.ts
// wc -l output.ts → 812
```
or
```typescript
// increment counter
count += 1;
```

**After:**
```typescript
// split into output.ts (pipeline summary) + status-map.ts (STATUS_MAP)
// re-export public API from index.ts so callers unchanged
```
or
```typescript
count += 1;   // comment deleted; the code already states "increment counter"
```

**Wins:** Bullets (≤6 words each).
**Evidence:** <cite exact tool output>

---

### 2. <short title> [Worth exploring]

...

## Top Recommendation

**<candidate name>** — one sentence why.

## Summary

| Candidate | Rule | Source | Lines changed | Risk |
|-----------|------|--------|---------------|------|
| 1         | File size | SonarQube S104 | -300 → new file | Low |
| 2         | What-comment | Clean Code ch. 4 | -1 | Low |
...

````

### 4 — Create sub-issues

Per candidate, create a **proper GitHub sub-issue** linked to the umbrella — not a standalone issue with a cross-reference comment. GitHub's sub-issue relationship is set at create time with `--parent`; it cannot be added by a comment later.

Create the umbrella issue first (Step 3) and **capture its issue number** (printed in `gh issue create` output). Then create each sub-issue anchored to that parent:

```
gh issue create \
  --title "CLEAN: <candidate short title>" \
  --label clean-code[,<submodule-name>] \
  --body-file <body-file> \
  --parent <umbrella-number>
```

The `--parent <number>` flag is the **only** mechanism that produces a real sub-issue in GitHub's issue hierarchy. Cross-reference comments and body mentions do **not** create the parent-child link — issues filed that way are independent issues that merely mention each other, which is exactly the bug we are fixing here.

Sub-issue fields:
- **Title:** `CLEAN: <candidate short title>`
- **Body:**
  ````
  Part of **Clean Code Audit: <target-name>** (#N)

  **Rule:** Rule 1 (file size) / Rule 2 (self-documenting code)
  **Source authority:** <cite — e.g. SonarQube S104 default 1000 lines; Clean Code ch. 4 "Explain yourself in code">
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
  - [ ] Error behaviour preserved (for splits: re-exports keep call sites stable)
  - [ ] Teammate would approve as net improvement
  ````
- **Labels:** same as umbrella (`clean-code` + submodule name)
- The body opens with `Part of **Clean Code Audit: <target-name>** (#N)` (informational only; the real parent link is set by `--parent`, not this line).

### 5 — Board, complete

1. Add umbrella and all sub-issues to project board with status `Research` (use `gh project item-edit` or GraphQL). The parent-child hierarchy is already rendered in the GitHub UI via `--parent`; **do not** also post a comment table — that duplicates the native sub-issue list.
2. Print all issue URLs

> Clean code audit filed. Umbrella: **#N**. Sub-issues: **#A**, **#B**. Apply with `/supervisor <number>` on any candidate.

## The Two Rules

### Rule 1 — File Size

A source file that grows beyond a few hundred lines signals that more than one responsibility has been collected in a single place. The thresholds are calibrated against SonarQube rule S104 whose default ceiling is 1000 lines [1], and against _Code Complete_ where files approaching 1000 lines sit at the upper bound of maintainability [2]. Function-length ceilings follow _Clean Code_ ch. 3, where functions of 4–20 lines are ideal and ~100 is the hard cap [3]. The 3-level indentation rule follows the Linux kernel coding style §1 [4]. Column limits follow Google Java/TypeScript style (100, 80 for kernel/TS-strict) [4][5].

### Rule 2 — Self-Documenting Code

Robert C. Martin states the principle directly in _Clean Code_ ch. 4: "Comments do not make up for bad code. We should be explaining ourselves in code." [3] The reader's three questions — _what_, _how_, _why_ — map to three answers: naming/types/signatures answer _what_, structure answers _how_, comments answer _why_ only [6]. A comment that answers _what_ is a signal that the code does not yet speak for itself; refactor it away rather than annotating it.

## Refactor Patterns

### Rule 1 — split strategy

When a file crosses a threshold, proceed as follows:

1. Identify cohesive clusters — UI vs logic vs types vs config vs tests.
2. Extract each cluster into a named sub-module (`helpers.ts`, `types.ts`, `logic.ts`).
3. Re-export the public API from an `index.ts` / `__init__.py` so existing callers continue to work.
4. Run the test suite after every extraction; revert any extraction that turns a test red.

When a function crosses a threshold, extract a named helper from its largest cohesive span, then verify the call site reads as English at the extraction point.

### Rule 2 — comment refactor

When a "what" comment is found, do not delete it silently. Apply the following sequence:

1. **Extract** the block it describes into a function whose name states the intent (the comment becomes a call site that reads as a sentence).
2. **Rename** cryptic locals (`d` → `daysSinceLastLogin`) so intent surfaces without a comment.
3. **Delete** the comment once the code communicates the same information on its own.
4. **Verify** the code now reads without the comment; if not, return to step 1 and extract further.

If the block is too tangled to express intent through naming alone, extract first and only then delete the comment — fix the code, not the annotation [3].

## Exemptions

The size rule does not apply to files that are not authored by hand: auto-generated output (lockfiles, protobuf bindings, schema dumps, build artifacts), vendored third-party code under `vendor/` / `node_modules/` / `third_party/`, and test fixture data files where bulk is the point.

The comment rule does not apply to: docstrings and JSDoc on public APIs (they document the contract, not the mechanism); marker comments (`TODO`, `FIXME`, `HACK`, `XXX`) and `ponytail:` markers (they record deferred decisions, i.e. _why_); legal headers and license blocks; regex explanations where the pattern is inherently opaque to a human reader.

## Sources

The thresholds and patterns are drawn from the following sources, each cited so the rule can be re-evaluated as practice changes. Every sub-issue names the source that grounds its specific threshold.

- [1] SonarSource, "S104: Files should not have too many lines", _SonarQube Server Documentation_. Default threshold 1000 lines; the built-in Sonar Way quality gate fails on any new issue introduced on new code. <https://docs.sonarsource.com/sonarqube-server/user-guide/code-metrics/metrics-definition>
- [2] Steve McConnell, _Code Complete_, 2nd ed. (Microsoft Press, 2004), ch. 7 "How Long Can a Routine Be?" and ch. 27 "Layout and Style". Routines beyond 200 lines correlate with lower correctness; file size should permit an author to hold the whole structure in view.
- [3] Robert C. Martin, _Clean Code: A Handbook of Agile Software Craftsmanship_ (Prentice Hall, 2008), ch. 3 "Functions" (functions should be small, ideally 4–20 lines, never exceeding ~100) and ch. 4 "Comments" ("Don't comment bad code — write it"; "Explain yourself in code").
- [4] Linus Torvalds et al., _Linux Kernel Coding Style_, §1 Indentation (> 3 levels = refactor) and §2 Breaking long lines and strings (80-column limit; functions should fit on one screen). <https://www.kernel.org/doc/html/latest/process/coding-style.html>
- [5] Google, _Google Java Style Guide_ §3.4 (100-column limit); _Google TypeScript Style Guide_ (column limit 80, raised to 100 with configuration). <https://google.github.io/styleguide/javaguide.html>
- [6] Wouter, "Self-documenting is a myth, and how to make your code self-documenting", _DEV Community_, 2019. Articulates the what / how / why division that underpins Rule 2. <https://dev.to/woubuc/self-documenting-is-a-myth-and-how-to-make-your-code-self-documenting-3h2n>
- [7] Microsoft, "Code metrics — Maintainability Index range and meaning", _Visual Studio Documentation_. The maintainability index ranges 0–100; a green rating (20–100) corresponds to highly maintainable code, a quantitative complement to the line-count heuristic. <https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-maintainability-index-range-and-meaning>

## Common Rationalisations

| Rationalisation | Reality |
|---|---|
| "It's working, no need to touch it" | Working code above 1000 lines is hard to hold in view; the next change costs more than the split does now. |
| "The comment explains it for juniors" | A junior reads the comment and the code, then trusts the comment when they diverge. A well-named function teaches the junior and stays correct. |
| "Fewer lines is always simpler" | A 1-line nested ternary is not simpler than a 5-line if/else. The audit flags _size_, not _line count_; comprehension speed is the metric. |
| "The original author must have had a reason" | Maybe. Check `git blame` — apply Chesterton's Fence. But accumulated size and restating comments are usually residue of iteration under pressure, not design. |
| "We'll split it when we touch it next" | Scope creep. File a sub-issue now so the split is visible at planning time, not discovered mid-feature. |
| "Types make it self-documenting" | Types document structure, not intent. A `user.role === 'admin'` check with a `// check if admin` comment needs a `isAdmin(user)` predicate, not a type annotation. |

## Red Flags

- A split that changes any call site reachable from outside the file (re-exports must keep the public surface stable).
- A comment deletion on side-effecting code where the comment hid a non-obvious ordering constraint — re-read for "why" before deleting.
- Refactoring code outside the scope of the audit without being asked.
- Batching a file split and a comment refactor into one commit; each sub-issue is its own reviewable change.
- Flagging a generated or vendored file because `wc -l` returned a large number — check the header and the path first.

## Verification

After completing an audit pass:

- [ ] Every candidate cites a source authority and tool output
- [ ] Every sub-issue's before/after preserves behaviour identically (Rule 1 splits via re-export; Rule 2 deletes comment only)
- [ ] All existing tests pass without modification after the refactor is applied
- [ ] Build succeeds with no new warnings
- [ ] Linter/formatter passes
- [ ] Each sub-issue is a reviewable, incremental change
- [ ] No generated or vendored file was flagged
- [ ] A teammate or review agent would approve each change as a net improvement

## Tone

Lean editorial. No hedging, no throat-clearing. Sentence → bullet if possible. Bullet → cut if possible. Every audit recommendation cites the specific rule, the specific source, and the exact tool output that evidences it.