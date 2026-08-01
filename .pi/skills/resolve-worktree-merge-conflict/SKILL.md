---
name: resolve-worktree-merge-conflict
description: "Resolve merge conflicts on PR branches that live in git worktrees. Use whenever a PR shows CONFLICTING or DIRTY merge state, 'git merge origin/main' or a rebase reports conflicts, a worktree branch must absorb origin/main changes, or two PRs touch the same files (same-family refactors). Covers conflict diagnosis, combined-semantics resolution, test-file merging, dead-reference sweeps, verification by build/test, and clean rebase history. Trigger even on short asks like 'fix the conflict', 'PR is not mergeable', or 'rebase this branch'."
---

# Resolve Worktree Merge Conflict

Resolves merge conflicts on a PR branch that is checked out in a git worktree. The conflict is a symptom; the root cause is that origin/main moved after the branch was cut — often a same-family PR touching the same files. Fix the root cause: understand what BOTH sides intended and merge the semantics, never pick one side blindly.

## Triggers

- `gh pr view <n>` shows `mergeStateStatus: DIRTY` or `mergeable: CONFLICTING`
- `git merge` or `git rebase` reports conflicts on a worktree branch
- Two PRs changed overlapping files (interfaces, structs, tests)
- User asks to fix a conflict, merge main into a branch, or rebase a branch

## Hard rules

1. **Never commit to main.** Main is locked. All work happens on the branch's worktree. Stash (never delete) unrelated modified files found in the main worktree — they may be harness-owned; `git stash` keeps them recoverable.
2. **Root cause first.** Before touching a conflicted file, know what changed on main since the branch point. The resolution shape follows from that diff.
3. **Verify by executing**, not by reading: build, vet, test, and grep for leftover references to deleted symbols.

## Preconditions

```bash
# Repo + PR metadata
gh auth status
gh pr view <PR> --json mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName

# Fresh remote state
git fetch origin
git worktree list        # find the branch's worktree; add if missing:
# git worktree add <path> <branch>    # e.g. /workspaces/worktree-<branch>
```

Exit non-zero or PR state unclear → stop and report before proceeding.

## Step 1 — Diagnose before resolving

```bash
# Where did the branch split from main, and what landed since?
git merge-base <branch-head> origin/main
git log --oneline <merge-base>..origin/main        # commits main gained
git diff --stat <merge-base> origin/main           # files main touched
git diff --name-only <merge-base> origin/main      # intersect with PR's files
```

Read the PR's own file list and the main-side file list. The overlap set is the conflict surface. Identify the other PR(s) that touched the same files — same-family refactors (interface removals, test rewrites, port/DI changes) are the classic cause. Note what each side was doing *conceptually*: deletion PRs compose (both sides removed different things from the same file → remove both), while replacement PRs override.

## Step 2 — Pull origin/main into the branch worktree

```bash
cd <worktree-path>
git merge origin/main
# or, for clean history (branch = origin/main + PR commit only):
git rebase origin/main
```

Pick based on history preference:
- **Merge**: preserves branch history, but the merge commit pulls ALL of main's changes into the branch. PR diff vs main stays clean, but branch history carries main.
- **Rebase**: branch becomes origin/main + the PR's own commits only. Preferred when the branch must contain only the PR's changes. Conflicts are resolved identically either way.

## Step 3 — Resolve conflicts semantically

`git status` lists unmerged paths. For each conflicted file:

1. **Read both sides per hunk.** Conflict markers show `HEAD` (the branch's PR work) vs the incoming side (origin/main's version). Ask what each side intended at each marker.
2. **Combine deletions.** When both PRs deleted different symbols from the same file, keep the union of deletions. This is the most common resolution and the easiest to get wrong by picking one side's deletion set.
3. **Keep only genuine seams.** In refactors that delete single-impl interfaces wrapping stdlib (extractors, renderers, resolvers, scaffolders), keep interfaces only where the seam is real (network/external-service boundaries, injected clients). Call the concrete adapters directly elsewhere. When main simultaneously removed CLI/exec seams from the same struct, the merged struct keeps only the surviving seams.
4. **Delete the dead references the deletions leave behind**, in the same commit: wiring variables, unused constructor args, mock types, compile-time interface checks (`var _ Iface = ...`), test helpers for removed types. A deletion PR that compiles is not finished.
5. **Merge test files semantically, not textually.** Tests carry most conflicts (often 70%+). Each test needs: main's newer helpers if the code-under-test changed shape (e.g. package-level docker/config stubs), the branch's hermetic helpers (e.g. real git identity via `GIT_CONFIG_GLOBAL` + `t.Setenv`), and dropped tests for removed features (`ports.X = nil` tests, removed-interface mocks). Rewrite `Validate()`-style tests to check only the surviving seams.
6. **Leave pre-existing formatting dirt alone.** If files were already unformatted at the merge-base, that dirt predates the PR — do not reformat unrelated regions. Only keep what you touch consistent.

## Step 4 — Verify by execution

```bash
# Language-agnostic equivalents; Go shown as the example stack
go build ./...
go vet ./<changed-package>/
go test ./<changed-package>/ -count=1 -timeout 60s
```

Then sweep for dead symbols — every interface/type/mock the conflict removed:

```bash
rg -n "<deleted-symbol>" --glob '!ignore/**'   # zero hits required
```

Also verify: compile-time interface checks reduced to surviving seams only; no test still references a removed port/mock. If a grep hits, that is an unfinished deletion — fix it before committing.

## Step 5 — Commit and push

```bash
git add <resolved-files>
GIT_EDITOR=true git commit        # containers often have no $EDITOR
git push origin <branch>          # --force-with-lease after a rebase
```

Use `GIT_EDITOR=true` — a missing editor aborts commits/rebase continuations silently.

## Step 6 — Re-check PR state (race guard)

The PR may auto-merge while you work, or its state may have changed:

```bash
gh pr view <PR> --json mergeable,mergeStateStatus,state
```

- If `state: MERGED`: verify the merged tree equals your resolution — `git diff <your-resolution-commit> origin/main -- <files>` should be empty for the PR's files. The branch head may be orphaned (remote branch points at an unmerged rebased commit); report it, do not delete without confirmation.
- If still CONFLICTING/DIRTY: diagnose again from Step 1; new main commits may have landed.
- If the user asked for a rebase but the PR merged with the pre-rebase head: the merged content is what matters; the rebased head is orphaned — report and offer reset/deletion.

## Rebase variant (clean history)

When the branch must contain only the PR's changes (no merge commit, no main history):

```bash
# 1. Snapshot the resolved files before reset
cp <resolved-files> /tmp/resolved-<PR>/          # delete after use

# 2. Return the branch to its pre-merge head, then rebase onto main
git reset --hard <pre-merge-head>
git rebase origin/main

# 3. Re-apply the resolutions over the conflicts, then continue non-interactively
cp /tmp/resolved-<PR>/* <conflicted-paths>
GIT_EDITOR=true git rebase --continue

# 4. Overwrite the remote branch head
git push --force-with-lease origin <branch>
rm -rf /tmp/resolved-<PR>
```

Reapply the full resolved file rather than re-resolving by hand — the semantic resolution from Step 3 holds regardless of history shape.

## Error handling

| Scenario | Action |
|----------|--------|
| `gh pr view` fails or auth missing | Stop. "Run `gh auth login`." |
| `git merge` aborts (dirty worktree) | `git merge --abort`, stash the branch worktree's unrelated changes, retry |
| No editor in container | Always `GIT_EDITOR=true` |
| Push rejected after rebase | `git fetch origin`; PR may have merged — check state before `--force-with-lease` |
| Grep finds leftover deleted symbols | Deletion incomplete — finish Step 4 before committing |
| Main worktree has modified files | `git stash` them (recoverable), never `git checkout --` or delete |
| PR auto-merged mid-work | Verify merged tree equality (Step 6); report orphaned head |

## Rules

1. **Root cause, not symptom** — diagnose what main gained before resolving.
2. **Both sides intended something** — combine semantics, never pick one side.
3. **Deletion PRs compose** — union of deletions, then sweep dead references.
4. **Verify by execution** — build, vet, test, grep; no reading-only sign-off.
5. **Never touch main** — worktree only; stash strays, don't delete.
6. **Non-interactive everywhere** — `GIT_EDITOR=true` for commits and rebases.
7. **Race-aware** — re-check PR state after push; auto-merge can win.
8. **Report outcome** — resolution commit, PR mergeable state, orphaned heads, any stash made.
