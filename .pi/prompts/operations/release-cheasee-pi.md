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

If `LAST_TAG` is set, get all merge commits since that tag:

```bash
git log "$LAST_TAG"..HEAD --oneline --merges --grep="Merge pull request" > /tmp/merge-commits.txt
```

If no merge commits found OR no tags exist, fetch recent merged PRs via `gh`:

```bash
gh pr list --repo "$REPO" --state merged --limit 50 --json number,title,url --jq '.[] | "\(.number) | \(.title) | \(.url)"' > /tmp/recent-prs.txt
```

Otherwise, extract PR numbers from merge commits and fetch details:

```bash
grep -oP 'Merge pull request #\K\d+' /tmp/merge-commits.txt > /tmp/pr-numbers.txt
while read -r NUM; do
  gh pr view "$NUM" --repo "$REPO" --json number,title,url --jq '"\(.number) | \(.title) | \(.url)"'
done < /tmp/pr-numbers.txt > /tmp/prs.txt
```

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

After categorizing, write categorized PRs to a temp file:

```bash
cat > /tmp/categorized-prs.txt << 'EOF'
...
EOF
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

### Step 9 — Run All Tests

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

### Step 10 — Build Release Body

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
- PR Title ([#N](github.com/SchneiderDaniel/cheasee-pi/pull/N))
```

Use the categorized list to produce real content. Omit any category with zero entries. Write body to a temp file:

```bash
cat > /tmp/release-body.md << 'BODY'
## Release v{NEW_VERSION}
... [actual content from categories]
BODY
```

### Step 11 — Create Tag

```bash
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
git push origin "v$NEW_VERSION"
```

### Step 12 — Create GitHub Release

```bash
gh release create "v$NEW_VERSION" \
  --repo "$REPO" \
  --title "Release v$NEW_VERSION" \
  --notes-file /tmp/release-body.md
```

### Step 13 — Confirm

Print confirmation:

```
Release v$NEW_VERSION created successfully.
URL: https://github.com/SchneiderDaniel/cheasee-pi/releases/tag/v$NEW_VERSION
```

Print the release body for user review.

## Constraints

- **Do NOT create tag or release if any test fails.** Hard stop.
- Use `gh` CLI for all GitHub operations — not curl, not raw API calls.
- PR categorization is done by LLM reading PR titles, not by fixed keyword list.
- Version base always comes from the latest semver tag (strip `v` prefix).
- If no tags exist, start from `0.1`.
- Only one increment applied: either +0.1 or +0.01, never both, never stacked.
- Trim version to 2 decimal places.

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
- [ ] Tests run and pass before creating tag
- [ ] Release body includes all categories with PR links
- [ ] Tag pushed to remote
- [ ] GitHub release created with notes
