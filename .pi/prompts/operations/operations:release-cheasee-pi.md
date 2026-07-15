---
description: Create a new GitHub release for cheasee-pi. Determine version from feature count since last tag, fetch and categorize all merged PRs, run all checks (TypeScript + Go + GoReleaser), create tag, let GoReleaser publish artifacts, then update release body.
---

# Release — cheasee-pi

Creates a new GitHub release for the `SchneiderDaniel/cheasee-pi` repository.

Requires: `gh` CLI authenticated, `git` in PATH, `go` in PATH, `goreleaser` CLI in PATH.

## Architecture

This repo has a **dual release** model:

- **TypeScript/Node** — pi extension code, tested via `npm test`, version in `package.json`
- **Go CLI** — `cmd/cheasee-pi/`, tested via `go test`, version in `root.go` and `docs/installation.md`

When a tag `v*` is pushed, the **GoReleaser GitHub Actions workflow** (`.github/workflows/release.yml`)
builds Go binaries for linux/mac/windows (amd64+arm64), creates archives + checksums, and publishes
them to the GitHub release. The release skill therefore does NOT use `gh release create` — it lets
GoReleaser own artifact publishing. After GoReleaser finishes, this skill updates the release body
with categorized PR notes.

## Workflow

### Step 1 — Run All Checks

Run all pre-release checks. If any fails, stop immediately.

#### 1a — TypeScript Compilation

```bash
npm run tsc:extensions
TSC_EXIT_CODE=$?
```

If `TSC_EXIT_CODE != 0`:

> **STOP.** TypeScript compilation failed. Fix type errors before releasing. Do not create release.

#### 1b — Node Test Suite

```bash
npm test
TEST_EXIT_CODE=$?
```

If `TEST_EXIT_CODE != 0`:

> **STOP.** Tests failed (exit code $TEST_EXIT_CODE). Release aborted. Fix failing tests before retrying.

#### 1c — Go Build Check

```bash
go build ./cmd/cheasee-pi/
GO_BUILD_EXIT_CODE=$?
```

If `GO_BUILD_EXIT_CODE != 0`:

> **STOP.** Go compilation failed. The Go CLI binary does not compile. Fix before releasing.

#### 1d — Go Vet (static analysis)

```bash
go vet ./cmd/cheasee-pi/...
GO_VET_EXIT_CODE=$?
```

If `GO_VET_EXIT_CODE != 0`:

> **STOP.** Go vet found issues. Fix before releasing.

#### 1e — Go Test Suite

```bash
go test ./cmd/cheasee-pi/...
GO_TEST_EXIT_CODE=$?
```

If `GO_TEST_EXIT_CODE != 0`:

> **STOP.** Go tests failed. Fix before releasing.

#### 1f — GoReleaser Config Validation

```bash
goreleaser check
GORELEASER_CHECK_EXIT_CODE=$?
```

If `GORELEASER_CHECK_EXIT_CODE != 0`:

> **STOP.** GoReleaser config (.goreleaser.yml) is invalid. Fix before releasing.

### Step 2 — Configuration

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

Ensure temp directory exists:

```bash
mkdir -p ignore
```

### Step 3 — Ensure on Main Branch

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

### Step 4 — Get Last Tag

```bash
git fetch --tags origin
export LAST_TAG=$(git tag --sort=-creatordate | head -1)
```

If no tags exist, set `LAST_TAG=""` and use starting version `0.1` as base.

Print:

```
Last tag: $LAST_TAG
```

### Step 5 — Determine Base Version

If `LAST_TAG` is set:

```bash
export BASE_VERSION=$(echo "$LAST_TAG" | sed 's/^v//')
```

If no tags exist, `BASE_VERSION=0.1`.

### Step 6 — Find Merged PRs Since Last Tag

#### Case A — Last tag exists

Get all merge commits since that tag:

```bash
git log "$LAST_TAG"..HEAD --oneline --merges --grep="Merge pull request" > ignore/merge-commits.txt
```

**If no merge commits found:** there are zero new PRs since last release. Stop and inform user:

> No new merged PRs since $LAST_TAG. Nothing to release.

Do not proceed further.

**Otherwise:** extract PR numbers from merge commit messages:

```bash
grep -oP 'Merge pull request #\K\d+' ignore/merge-commits.txt > ignore/pr-numbers.txt
echo "Found $(wc -l < ignore/pr-numbers.txt) merged PRs since $LAST_TAG"
```

Fetch details for each PR:

```bash
while read -r NUM; do
  TITLE=$(gh pr view "$NUM" --repo "$REPO" --json title --jq '.title' 2>/dev/null || echo "(unknown)")
  echo "$NUM | $TITLE | https://github.com/$REPO/pull/$NUM"
done < ignore/pr-numbers.txt > ignore/prs.txt
```

Read the PR list:

```bash
cat ignore/prs.txt
```

#### Case B — No tags exist (first release)

All merged PRs are relevant. Fetch via `gh` with pagination to avoid limit caps:

```bash
gh pr list --repo "$REPO" --state merged --limit 100 --json number,title,url --jq '.[] | "\(.number) | \(.title) | \(.url)"' > ignore/prs.txt
```

If output has exactly 100 lines, warn that there may be more PRs beyond the 100 fetched:

> Warning: PR list capped at 100. Some older PRs may not be included.

Read the PR list:

```bash
cat ignore/prs.txt
```

### Step 7 — Categorize PRs

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

### Step 8 — Count Features

After categorizing, write categorized PRs to a temp file using the `write` tool:

```bash
write ignore/categorized-prs.txt
...
```

Then count feature entries (lines where second field is `features`):

```bash
export FEATURE_COUNT=$(awk -F ' \| ' '$2 == "features"' ignore/categorized-prs.txt | wc -l)
```

Print:

```
Feature count since last release: $FEATURE_COUNT
```

### Step 9 — Calculate New Version

Version logic:

- If `FEATURE_COUNT >= 10`: increment = 0.1
- If `FEATURE_COUNT < 10`: increment = 0.01

```bash
if [ "$FEATURE_COUNT" -ge 10 ]; then
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
Increment: $( [ "$FEATURE_COUNT" -ge 10 ] && echo "0.1" || echo "0.01" )
New version: v$NEW_VERSION
```

### Step 10 — Guard: Check for Existing Tag

Verify the new version doesn't already exist as a tag:

```bash
if git rev-parse --verify "v$NEW_VERSION" >/dev/null 2>&1; then
  echo "ERROR: Tag v$NEW_VERSION already exists."
  echo "Delete it first: git tag -d v$NEW_VERSION && git push --delete origin v$NEW_VERSION"
  exit 1
fi
```

If tag exists, stop and inform user. Do not overwrite.

### Step 11 — Preview + Confirmation

Build the full preview content:

```
═══ Release Preview ═══

Base version: $BASE_VERSION
New version:  v$NEW_VERSION
Feature count: $FEATURE_COUNT
Increment:    0.XX

Files to update:
  - package.json: version -> $NEW_VERSION
  - cmd/cheasee-pi/root.go: Version -> "$NEW_VERSION"
  - docs/installation.md: VERSION -> "$NEW_VERSION"

GoReleaser will auto-publish:
  - linux (amd64, arm64) — tar.gz
  - darwin (amd64, arm64) — tar.gz
  - windows (amd64, arm64) — zip
  - checksums.txt

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

Save the preview to `ignore/release-preview.md` using the `write` tool for user reference:

```bash
write ignore/release-preview.md
═══ Release Preview ═══
...
```

Then **ask the user for confirmation** before proceeding. Use a choice prompt:

> "Create release v$NEW_VERSION?"
> Options: [Create] [Preview release body] [Cancel]

If user cancels, stop. Do not create tag or push.

### Step 12 — Sync Versions Across All Files

Three files need version updates. Edit them all before committing.

#### 12a — package.json

Find the current `"version"` field in `package.json` and replace it with `"$NEW_VERSION_CLEAN"` where NEW_VERSION_CLEAN = version without `v` prefix:

```bash
export NEW_VERSION_CLEAN=$(echo "$NEW_VERSION" | sed 's/^v//')
```

Use the `edit` tool to replace `"version": "1.0.0"` (or whatever the current version is) with `"version": "$NEW_VERSION_CLEAN"` in `package.json`.

#### 12b — cmd/cheasee-pi/root.go

The version string in `root.go` is in the `rootCmd` declaration. Replace the current version string with the new one.

Use the `edit` tool on `cmd/cheasee-pi/root.go`:

Find: `Version:            "X.X.X",` (where X.X.X is the current `BASE_VERSION`)
Replace with: `Version:            "$NEW_VERSION_CLEAN",`

(Keep the exact spacing. Use `read` to verify the current line.)

#### 12c — docs/installation.md

The `VERSION="X.X.X"` line in `docs/installation.md` must match.

Use the `edit` tool on `docs/installation.md`:

Find: `VERSION="X.X.X"` (where X.X.X is the current `BASE_VERSION`)
Replace with: `VERSION="$NEW_VERSION_CLEAN"`

### Step 13 — Commit Version Bump

```bash
git add package.json cmd/cheasee-pi/root.go docs/installation.md
git commit -m "chore: bump version to v$NEW_VERSION"
```

### Step 14 — Build Release Body (for later use)

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
write ignore/release-body.md
...
```

### Step 15 — Create Tag

```bash
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
```

### Step 16 — Push Tag + Version Commit

```bash
git push origin main
git push origin "v$NEW_VERSION"
```

### Step 17 — Wait for GoReleaser + Update Release Body

After the tag is pushed, the GitHub Actions workflow `.github/workflows/release.yml` auto-triggers.
This workflow runs `goreleaser release --clean` which:
1. Builds Go binaries for all targets
2. Creates archives (tar.gz / zip)
3. Generates checksums.txt
4. Creates/updates the GitHub release with assets

**Do not proceed until GoReleaser has completed.** Check the Actions status:

```bash
gh run list --repo "$REPO" --workflow "Release" --branch main --limit 5 --json conclusion,headBranch,createdAt,databaseId
```

Wait for the workflow run on the new tag to complete. Poll every 30s:

```bash
RUN_ID=$(gh run list --repo "$REPO" --workflow "Release" --branch "v$NEW_VERSION" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
```

If the workflow hasn't started yet (RUN_ID is empty), wait 30s and retry.
Once RUN_ID is available, wait for it to complete:

```bash
gh run watch "$RUN_ID" --repo "$REPO"
CONCLUSION=$(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq '.conclusion')
```

If `CONCLUSION != "success"`:

> **WARNING.** GoReleaser workflow finished with status: $CONCLUSION. The release may be incomplete.
> Check: https://github.com/$REPO/actions/runs/$RUN_ID

Print a warning but do not block the release body update — the user should investigate.

### Step 18 — Update Release Body

GoReleaser creates the release but uses an auto-generated changelog (git log).
Replace it with the categorized PR list built in Step 14.

```bash
gh release edit "v$NEW_VERSION" --repo "$REPO" --notes-file ignore/release-body.md
```

### Step 19 — Confirm

Print confirmation:

```
Release v$NEW_VERSION published.

Version bump commit:  (hash)
Tag:                 v$NEW_VERSION
Release URL:         https://github.com/SchneiderDaniel/cheasee-pi/releases/tag/v$NEW_VERSION
GoReleaser run:      https://github.com/SchneiderDaniel/cheasee-pi/actions/runs/$RUN_ID

Go CLI artifacts (attached to release):
  - cheasee-pi_{version}_linux_amd64.tar.gz
  - cheasee-pi_{version}_linux_arm64.tar.gz
  - cheasee-pi_{version}_darwin_amd64.tar.gz
  - cheasee-pi_{version}_darwin_arm64.tar.gz
  - cheasee-pi_{version}_windows_amd64.zip
  - cheasee-pi_{version}_windows_arm64.zip
  - checksums.txt

To roll back: git tag -d v$NEW_VERSION && git push --delete origin v$NEW_VERSION && git revert <commit-hash>
```

### Step 20 — Clean Up Temp Files

Remove all temporary files created during the release process:

```bash
rm -f ignore/merge-commits.txt ignore/pr-numbers.txt ignore/prs.txt ignore/categorized-prs.txt ignore/release-preview.md ignore/release-body.md
```

Confirm cleanup:

```
Temporary files cleaned from ignore/.
```

## Constraints

- **Do NOT create tag or release if any check fails.** Hard stop on: TSC errors, test failures, Go build failure, Go vet failure, Go test failure, GoReleaser config invalid.
- **Ask user confirmation before any irreversible action** (tag push).
- Version sync must be consistent across three files: `package.json`, `cmd/cheasee-pi/root.go`, `docs/installation.md`.
- **Do NOT use `gh release create`.** GoReleaser owns release creation. The skill pushes a tag and the GitHub Actions workflow handles artifact publishing.
- Release body is updated AFTER GoReleaser finishes, via `gh release edit`.
- Use `gh` CLI for all GitHub operations — not curl, not raw API calls.
- PR categorization is done by LLM reading PR titles, not by fixed keyword list.
- Version base always comes from the latest semver tag (strip `v` prefix).
- If no tags exist, start from `0.1`.
- Only one increment applied: either +0.1 or +0.01, never both, never stacked.
- Threshold: >= 10 features → +0.1, < 10 features → +0.01.
- Trim version to 2 decimal places.
- Do not overwrite existing tags — check first and stop if duplicate.
- Use `write` tool for file creation, not `cat >` in bash.
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
- [ ] Version calculation follows rules (>=10 → +0.1, <10 → +0.01)
- [ ] Duplicate version tag does not already exist
- [ ] User confirmed release preview before proceeding
- [ ] TypeScript compiles cleanly (`npm run tsc:extensions`) — Step 1a
- [ ] All Node tests pass (`npm test`) — Step 1b
- [ ] Go compiles cleanly (`go build ./cmd/cheasee-pi/`) — Step 1c
- [ ] Go vet passes (`go vet ./cmd/cheasee-pi/...`) — Step 1d
- [ ] All Go tests pass (`go test ./cmd/cheasee-pi/...`) — Step 1e
- [ ] GoReleaser config valid (`goreleaser check`) — Step 1f
- [ ] `package.json` version field synced with new version
- [ ] `cmd/cheasee-pi/root.go` Version field synced
- [ ] `docs/installation.md` VERSION synced
- [ ] Version bump commit created with all three files
- [ ] Tag created and pushed
- [ ] GoReleaser workflow completed successfully
- [ ] Release body updated with categorized PRs (not flat commit list)
- [ ] Rollback instructions printed
