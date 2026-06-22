---
name: extension-bug-hunter
description: Systematic bug hunting for pi extensions. Picks random extension, analyzes code using best-practice bug hunting techniques, validates findings with reproducible proof, creates GitHub issue with full report. Use when auditing extension quality or before releases.
metadata:
  hunting-techniques: boundary-analysis,type-safety,error-path,concurrency,input-validation,state-mutation,resource-lifecycle,security,logic,api-misuse
  proof-standard: reproducible-steps-three-strikes
---

# Extension Bug Hunter

Systematic bug hunter for pi extensions. **Hunt all bugs.** Each invocation pick random extension, analyze using structured techniques, validate with proof, file ALL confirmed bugs. If no bugs found in selected extension, discard it and pick another. Repeat until all extensions exhausted.

## How It Works

### Phase 1 — Random Selection + Hunt Loop

This is a **hunt loop**. The core instruction: **file every bug with proof, regardless of severity.**

```
loop:
  1. Pick random extension from .pi/extensions/ (skip previously picked)
  2. Run Phase 2-4 (understand + hunt + validate) on this extension
  3. For every bug found WITH proof → file GitHub issue (Phase 5)
  4. After exhausting current extension, goto loop start (pick next extension)
  5. If ALL extensions exhausted → output "Hunt complete: N bugs found across all extensions"
```

**Critical rule:** Do NOT lower proof standards. A bug without proof is not a bug. Skip only if proof is insufficient — never skip a confirmed bug because it's minor.

### Phase 1a — Random Selection

Pick one extension from `.pi/extensions/` using `bash ls`. Prefer subdirectory extensions (they contain multiple files, more surface area). Single-file `.ts` extensions also eligible. Do NOT pick same extension twice in a row within same invocation.

Selection method:

```bash
ls -d /home/miria/git/main/.pi/extensions/*/   # subdirectory extensions
ls /home/miria/git/main/.pi/extensions/*.ts     # single-file extensions
```

Pick randomly. Document which extension selected and why (e.g. "largest file count" or "most recently modified").

### Phase 2 — Code Understanding

Read the full extension before hunting. Use `read` to load all files.

For subdirectory extensions:

```bash
ls -la /home/miria/git/main/.pi/extensions/<name>/
read /home/miria/git/main/.pi/extensions/<name>/index.ts
read /home/miria/git/main/.pi/extensions/<name>/<other-files>.ts
```

For single-file extensions:

```bash
read /home/miria/git/main/.pi/extensions/<name>.ts
```

Understand:

- Purpose (what does it register? tool? command? event handler?)
- API surface (tool name, params, returns, events subscribed)
- Dependencies (imports from pi packages, npm packages, node built-ins)
- State management (module-level state, session persistence, mutable variables)
- Error handling (try/catch patterns, error propagation, fallthrough)

### Phase 3 — Bug Hunting Techniques

Apply each technique below. For each, document what you checked and whether found anything.

#### 1. Boundary Analysis

- Off-by-one in array/string operations (`<=` vs `<`, `length` vs `length-1`)
- Empty/null/undefined states (empty arrays, null params, missing fields)
- Edge values (0, empty string, `Number.MAX_SAFE_INTEGER`, negative numbers)
- Pagination/iteration limits (cursor, offset, page size)
- Timeout/expiry boundary (race between timeout and completion)

#### 2. Type Safety Analysis

- `any` types or unsafe casts (`as` without validation)
- `details: {}` patterns (TypeBox schema vs plain object)
- Missing/null checks on optional fields
- Parameter schema mismatch (TypeBox vs runtime usage)
- Incorrect generic type parameters

#### 3. Error Path Tracing

- Unhandled promise rejections (no `.catch()`, no `try/catch`)
- Silent errors (empty `catch` block, error swallowed)
- Improper error propagation (returning error as success)
- Missing error context (error message without details)
- `try/catch` with no `catch` body or only `/* ok */`

#### 4. Concurrency Analysis

- Race conditions in file operations (multiple tools editing same file)
- Async/await mismatch (forgotten `await`, mixing sync/async)
- Shared mutable state across concurrent tool calls
- `Promise.all` without error handling
- Signal/abort not propagated to child operations

#### 5. Input Validation

- Missing parameter validation (tool params not checked)
- Incorrect TypeBox schema (wrong types, missing constraints)
- Path traversal (user path not sanitized, `../` injection)
- Shell injection (command strings built from user input)
- JSON parse without try/catch

#### 6. State Mutation Analysis

- Module-level mutable state (global variables, arrays, objects)
- State not rebuilt on `session_start`
- State stored outside tool result `details`
- Side effects in event handlers that modify session

#### 7. Resource Lifecycle

- File handles not closed (missing `finally` or cleanup)
- Temp files not deleted after use
- Event subscriptions not unsubscribed
- `AbortSignal` listeners not cleaned up
- Child processes not killed on timeout

#### 8. Security Analysis

- Command injection (user input in `execSync`, `pi.exec`, `bash`)
- Path traversal (file paths from user input not resolved)
- Trust boundary (LLM-generated content used in security decisions)
- API key exposure (keys in tool results, session data)
- Prompt injection vectors (user content in prompts without sanitization)

#### 9. Logic Errors

- Wrong comparison operator (`=` vs `==` vs `===`)
- Inverted condition (`!==` when should be `===`)
- Incorrect variable used (copy-paste error, wrong variable name)
- Missing return / early return
- Wrong default value

#### 10. API Misuse

- Incorrect pi extension API usage (wrong event signature, missing return shape)
- TypeBox schema not matching `prepareArguments` shape
- Tool result format wrong (missing `content` array, wrong `details` shape)
- Event return format wrong (wrong blocking return shape)
- `sendUserMessage` / `sendMessage` options misuse
- `withFileMutationQueue` not used for file-mutating custom tools

### Phase 4 — Bug Validation (Proof Requirement)

Every suspected bug MUST have proof. Rule: **"Three strikes"** — three independent confirmations before filing.

#### Proof Checklist

Each bug report must include ALL of:

1. **Code evidence** — Exact line(s) showing the bug
   ```
   File: path/to/file.ts, line 42-45
   ```
2. **Expected vs actual** — What should happen vs what does happen
   ```
   Expected: Throws error when path is "../etc/passwd"
   Actual:   Path passes through unsanitized
   ```
3. **Reproduction steps** — Minimal sequence to trigger
   ```
   1. Call tool with params { path: "../../../etc/passwd" }
   2. Observe file read outside project directory
   ```
4. **Impact assessment** — Severity, exploitability, affected users
   ```
   Severity: High — path traversal allows reading any file
   ```

#### When Proof Is Insufficient

If code is ambiguous (possible false positive), skip it. Do not file speculative bugs. When unsure, re-read the full file to trace the execution path. If still unsure, skip.

**Do NOT skip a confirmed bug because it's low severity.** If proof exists (code evidence + expected/actual + reproduction steps), file it regardless of impact level.

### Phase 5 — GitHub Issue Creation

Only create issue after proof is complete. Use `gh issue create` via `bash gh`.

#### Issue Template

```
**Extension:** <name>
**Technique:** <technique that found this>
**Severity:** <P0/P1/P2/P3>

## Description
<clear description of the bug>

## Proof

### Code Evidence
```

File: path/to/file.ts, line N-M
<code snippet showing bug>

```

### Expected vs Actual
Expected: <expected behavior>
Actual:   <actual behavior>

### Reproduction Steps
1. <step 1>
2. <step 2>
3. <step 3>

### Impact
<what this bug allows, who it affects>

## Suggested Fix
<optional: suggested code change>
```

#### Issue Creation Command

```bash
# Write body to temp file to avoid shell escaping issues
cat > ignore/bug-report-<ext-name>.md << 'EOF'
<body content>
EOF

gh issue create \
  --repo "$(cat /home/miria/git/main/.pi/settings.json | grep -o '"repo"[^,]*' | tail -1 | sed 's/.*"repo": *"\([^"]*\)".*/\1/')" \
  --title "Bug: <ext-name> - <short description>" \
  --label "bug" \
  --body-file ignore/bug-report-<ext-name>.md

# Clean up
rm ignore/bug-report-<ext-name>.md
```

Read repo from `.pi/settings.json`:

```bash
grep -o '"repo"[^,]*' /home/miria/git/main/.pi/settings.json | tail -1 | sed 's/.*"repo": *"\([^"]*\)".*/\1/'
```

#### Labels

Always add `bug` label. Add severity label if exists in repo: `severity:high`, `severity:medium`, `severity:low`.

#### Existing Issues Check

Before creating issue, check if similar bug already reported:

```bash
gh issue list --repo <repo> --label bug --state open --json title --limit 30 \
  | grep -i "<keyword>"
```

If duplicate found, skip and note which issue.

### Phase 6 — Report

After hunt loop completes (either bug filed or all extensions exhausted), output summary:

```
## Bug Hunt Report

**Extension:** <name>
**Files analyzed:** <count>
**Total lines:** <approximate>
**Techniques applied:** <all 10>

### Findings

| # | Technique | Type | Severity | Filed? |
|---|-----------|------|----------|--------|
| 1 | boundary | Off-by-one | P2 | [#123](url) |
| 2 | error-path | Unhandled rejection | P1 | [#124](url) |

### Summary
<total bugs found, total filed, any skips with reason>
```

## Rules

1. **Hunt all confirmed bugs** — Loop through all extensions, file every bug with proof. Do not stop after first bug. Minor + proof = file.
2. **ONE bug per issue** — No batching multiple bugs in one issue
3. **Proof or skip** — No speculative bugs. Only skip when proof is insufficient. Minor bugs with proof must be filed.
4. **Three strikes** — code evidence + expected/actual + reproduction steps minimum
5. **No duplicate** — Check existing open issues first
6. **File cleanup** — Delete temp files after issue creation
7. **Track picked extensions** — Maintain list of picked extensions this run. Never re-pick same extension within one invocation.
8. **LLM is the hunter** — Do NOT delegate analysis to tools. Read code directly, reason about it
9. **Structural search allowed** — Use `structural_search` for AST patterns (try/catch, function calls, class defs)
10. **Literal search allowed** — Use `ripgrep_search` for text patterns (magic numbers, error messages, `any` casts)
11. **No false positives** — If you cannot reproduce the bug by tracing the code path, do not file it. Minor bugs with clear proof must be filed regardless of severity.
12. **All exhausted = report** — If every extension checked and zero bugs found, output full report stating that. No fabricated bugs.

## Reference

See [references/bug-hunting-techniques.md](references/bug-hunting-techniques.md) for detailed technique descriptions with code patterns.
