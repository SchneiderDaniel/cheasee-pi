---
description: Create a new GitHub release for cheasee-pi. Determine version from feature count since last tag, fetch and categorize all merged PRs, run tests, create tag only if all pass.
---

# Release — cheasee-pi

Creates a new GitHub release for the `SchneiderDaniel/cheasee-pi` repository.

Requires: `gh` CLI authenticated, `git` in PATH.

## Workflow

### Step 1 — Configuration

Export repo variables:

```bash
export REPO="SchneiderDaniel/cheasee-pi"
export OWNER="SchneiderDaniel"
export REPO_NAME="cheasee-pi"
```

Verify `gh` is authenticated:

```bash
gh auth status
```

If not authenticated, stop and ask user to authenticate.

### Step 2 — Ensure on Main Branch

```bash
git branch --show-current
```

If current branch is not `main` (or the configured default branch), stop and inform:

> **STOP.** Current branch is `{branch}`. Releases must be cut from `main`. Switch to `main` and retry.

Also verify working tree is clean:

```bash
git status --porcelain
```

If output is non-empty, stop and inform:

> **STOP.** Working tree has uncommitted changes. Commit or stash before releasing.

### Step 3 — Get Last Tag

```bash
git fetch --tags origin
export LAST_TAG=$(git tag --sort=-creatordate | head -1)
```

If no tags exist, set `LAST_TAG=""` and use starting version `0.1` as base.

Print:

```
Last tag: $LAST_TAG
```

### Step 4 — Determine Base Version

If `LAST_TAG` is set:

```bash
export BASE_VERSION=$(echo "$LAST_TAG" | sed 's/^v//')
```

If no tags exist, `BASE_VERSION=0.1`.

### Step 5 — Find Merged PRs Since Last Tag

#### Case A — Last tag exists

Get all merge commits since that tag:

```bash
git log "$LAST_TAG"..HEAD --oneline --merges --grep="Merge pull request" > /tmp/merge-commits.txt
```

**If no merge commits found:** there are zero new PRs since last release. Stop and inform user:

> No new merged PRs since $LAST_TAG. Nothing to release.

Do not proceed further.

**Otherwise:** extract PR numbers from merge commit messages:

```bash
grep -oP 'Merge pull request #\K\d+' /tmp/merge-commits.txt > /tmp/pr-numbers.txt
echo "Found $(wc -l < /tmp/pr-numbers.txt) merged PRs since $LAST_TAG"
```

Fetch details for each PR:

```bash
while read -r NUM; do
  TITLE=$(gh pr view "$NUM" --repo "$REPO" --json title --jq '.title' 2>/dev/null || echo "(unknown)")
  echo "$NUM | $TITLE | https://github.com/$REPO/pull/$NUM"
done < /tmp/pr-numbers.txt > /tmp/prs.txt
```

Read the PR list:

```bash
cat /tmp/prs.txt
```

#### Case B — No tags exist (first release)

All merged PRs are relevant. Fetch via `gh` with pagination to avoid limit caps:

```bash
gh pr list --repo "$REPO" --state merged --limit 100 --json number,title,url --jq '.[] | "\(.number) | \(.title) | \(.url)"' > /tmp/prs.txt
```

If output has exactly 100 lines, warn that there may be more PRs beyond the 100 fetched:

> Warning: PR list capped at 100. Some older PRs may not be included.

Read the PR list:

```bash
cat /tmp/prs.txt
```

### Step 6 — Categorize PRs

Read each PR title and categorize it using your own judgment. Use these categories:

| Category | Description |
|----------|-------------|
| **features** | New functionality, enhancements, new commands, new tools, new APIs |
| **bugs** | Bug fixes, error corrections, crash fixes, hotfixes, regression fixes |
| **dead-code** | Removal of unused code, dead exports, unreachable paths, orphaned utilities |
| **duplicate-code** | Removal or consolidation of duplicate code, DRY improvements |
| **others** | Everything else: refactors, docs, CI, tests, dependencies, chores |

For each PR, determine its category from the title. Store in a structured list like:

```
# PR | Category | Title | URL
```

Print the categorized list.

### Step 7 — Count Features

After categorizing, write categorized PRs to a temp file using the `write` tool:

```
write /tmp/categorized-prs.txt
...
```

Then count feature entries (lines where second field is `features`):

```bash
export FEATURE_COUNT=$(awk -F ' \| ' '$2 == "features"' /tmp/categorized-prs.txt | wc -l)
```

Print:

```
Feature count since last release: $FEATURE_COUNT
```

### Step 8 — Calculate New Version

Version logic:

- If `FEATURE_COUNT >= 42`: increment = 0.1
- If `FEATURE_COUNT < 42`: increment = 0.01

```bash
if [ "$FEATURE_COUNT" -ge 42 ]; then
  export NEW_VERSION=$(echo "$BASE_VERSION + 0.1" | bc -l)
else
  export NEW_VERSION=$(echo "$BASE_VERSION + 0.01" | bc -l)
fi
```

Trim to 2 decimal places:

```bash
export NEW_VERSION=$(printf "%.2f" "$NEW_VERSION")
```

Print:

```
Base version: $BASE_VERSION
Feature count: $FEATURE_COUNT
Increment: $( [ "$FEATURE_COUNT" -ge 42 ] && echo "0.1" || echo "0.01" )
New version: v$NEW_VERSION
```

### Step 9 — Guard: Check for Existing Tag

Verify the new version doesn't already exist as a tag:

```bash
if git rev-parse --verify "v$NEW_VERSION" >/dev/null 2>&1; then
  echo "ERROR: Tag v$NEW_VERSION already exists."
  echo "Delete it first: git tag -d v$NEW_VERSION && git push --delete origin v$NEW_VERSION"
  exit 1
fi
```

If tag exists, stop and inform user. Do not overwrite.

### Step 10 — Preview + Confirmation

Print a full preview of what the release will contain:

```
═══ Release Preview ═══

Base version: $BASE_VERSION
New version:  v$NEW_VERSION
Feature count: $FEATURE_COUNT
Increment:    0.XX

Proposed release body:
---
## Release v{NEW_VERSION}

### Features
...

### Bug Fixes
...
...
---

Ready to create this release?
```

Then **ask the user for confirmation** before proceeding. Use a choice prompt:

> "Create release v$NEW_VERSION?"
> Options: [Create] [Preview release body] [Cancel]

If user cancels, stop. Do not create tag or release.

### Step 11 — Pre-Release TypeScript Check

Verify TypeScript compiles cleanly:

```bash
npm run tsc:extensions
```

Capture exit code:

```bash
export TSC_EXIT_CODE=$?
```

If `TSC_EXIT_CODE != 0`:

> **STOP.** TypeScript compilation failed. Fix type errors before releasing.

Do not proceed further.

### Step 12 — Run All Tests

```bash
npm test
```

Capture exit code:

```bash
export TEST_EXIT_CODE=$?
```

If `TEST_EXIT_CODE != 0`:

> **STOP.** Tests failed. Do NOT create any tag or release.
> Print the failing test output and inform the user:
> "Tests failed (exit code $TEST_EXIT_CODE). Release aborted. Fix failing tests before retrying."

Do not proceed further.

### Step 13 — Sync package.json Version

Update the `version` field in `package.json` to match the new release version:

```bash
export NEW_VERSION_CLEAN=$(echo "$NEW_VERSION" | sed 's/^v//')
```

Use the `edit` tool to replace `"version": "1.0.0"` (or whatever the current version is) with `"version": "$NEW_VERSION_CLEAN"` in `package.json`.

Then commit the change:

```bash
git add package.json
git commit -m "chore: bump version to v$NEW_VERSION"
```

### Step 14 — Build Release Body

Generate release notes from the categorized PR list. Format per category:

```markdown
## Release v{NEW_VERSION}

### Features
- PR Title ([#N](https://github.com/SchneiderDaniel/cheasee-pi/pull/N))

### Bug Fixes
- PR Title ([#N](https://github.com/SchneiderDaniel/cheasee-pi/pull/N))

### Dead Code Removal
- PR Title ([#N](https://github.com/SchneiderDaniel/cheasee-pi/pull/N))

### Duplicate Code Removal
- PR Title ([#N](https://github.com/SchneiderDaniel/cheasee-pi/pull/N))

### Other
- PR Title ([#N](https://github.com/SchneiderDaniel/cheasee-pi/pull/N))
```

Use the categorized list to produce real content. Omit any category with zero entries. Use the `write` tool to save the body:

```bash
# Use write tool to create /tmp/release-body.md with the release notes content
```

### Step 15 — Create Tag

```bash
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
```

Do not push yet — the tag will be pushed together with the version bump commit.

### Step 16 — Push Tag + Version Commit

```bash
git push origin main
git push origin "v$NEW_VERSION"
```

### Step 17 — Create Draft Release

Create the release as a **draft** so the user can review and publish manually:

```bash
gh release create "v$NEW_VERSION" \
  --repo "$REPO" \
  --title "Release v$NEW_VERSION" \
  --notes-file /tmp/release-body.md \
  --draft
```

### Step 18 — Confirm

Print confirmation:

```
Release v$NEW_VERSION prepared as draft.

Version bump commit:  (hash)
Tag:                 v$NEW_VERSION
Draft release URL:   https://github.com/SchneiderDaniel/cheasee-pi/releases/tag/v$NEW_VERSION

Next step: Review and publish the draft release on GitHub.
To roll back: git tag -d v$NEW_VERSION && git push --delete origin v$NEW_VERSION && git revert <commit-hash>
```

## Constraints

- **Do NOT create tag or release if any test fails.** Hard stop.
- **Ask user confirmation before any irreversible action** (tag push, release creation).
- Use `gh` CLI for all GitHub operations — not curl, not raw API calls.
- PR categorization is done by LLM reading PR titles, not by fixed keyword list.
- Version base always comes from the latest semver tag (strip `v` prefix).
- If no tags exist, start from `0.1`.
- Only one increment applied: either +0.1 or +0.01, never both, never stacked.
- Trim version to 2 decimal places.
- Do not overwrite existing tags — check first and stop if duplicate.
- Use `write` tool for file creation, not `cat >` in bash.
- Create releases as drafts — never publish immediately.
- Always sync `package.json` version field with the git tag.

## Quality Checklist

- [ ] `gh auth status` confirmed before any operation
- [ ] Current branch is `main` (or default branch)
- [ ] Working tree is clean (`git status --porcelain` empty)
- [ ] Tags fetched fresh with `git fetch --tags`
- [ ] Last tag correctly identified (or empty state handled)
- [ ] All merged PRs since last tag captured (not just recent N)
- [ ] PRs categorized by LLM reading titles
- [ ] Feature count is accurate
- [ ] Version calculation follows rules (>42 → +0.1, <42 → +0.01)
- [ ] Duplicate version tag does not already exist
- [ ] User confirmed release preview before proceeding
- [ ] TypeScript compiles cleanly (`npm run tsc:extensions`)
- [ ] All tests pass (`npm test`)
- [ ] `package.json` version field synced with new version
- [ ] Version bump commit created
- [ ] Tag created and pushed
- [ ] Release created as draft, not published directly
- [ ] Rollback instructions printed
