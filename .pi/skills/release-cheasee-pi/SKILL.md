---
name: release-cheasee-pi
description: Create a new GitHub release for cheasee-pi. Fetches all merged PRs since last tag, categorizes by title patterns, calculates version, runs checks (TypeScript + Go), syncs version strings, pushes tag for GoReleaser CI, updates release body. Use for any cheasee-pi release.
metadata:
  scope: cheasee-pi-repo-only
  dependencies: gh-cli, go, node
---

# Release — cheasee-pi

Creates a new GitHub release for `SchneiderDaniel/cheasee-pi`.

**Release model:** Push a `v*` tag → GitHub Actions (GoReleaser) builds binaries and publishes artifacts.
This skill owns the tag push and release body — GoReleaser owns artifact publishing.

**Scripts** (in `scripts/` relative to this skill):
- `fetch-prs.sh` — Fetch all merged PRs since last release tag
- `process-prs.mjs` — Categorize PRs, calculate version, build release body markdown
- `sync-version.mjs` — Update version string in all 4 files

**Script directory** (resolve relative to SKILL.md):

```bash
SKILL_DIR="$(dirname "$(readlink -f "$0")")/$(dirname "$(echo "$0" | sed 's|/SKILL.md||')")"
# Shorter: derive from finding SKILL.md
SKILL_DIR="$(cd "$(dirname "$(find /workspaces/main/.pi/skills/release-cheasee-pi -name SKILL.md)")" && pwd)"
```

Or just use the absolute path:

```bash
SKILL_DIR="/workspaces/main/.pi/skills/release-cheasee-pi"
```

---

## Step 1 — Run All Pre-Release Checks

Each check must pass before proceeding. Any failure → STOP.

### 1a — TypeScript

```bash
cd /workspaces/main && npm run tsc:extensions
```

### 1b — Node Tests

```bash
cd /workspaces/main && npm test
```

### 1c — Go Build

```bash
cd /workspaces/main && go build ./cmd/cheasee-pi/
```

### 1d — Go Vet

```bash
cd /workspaces/main && go vet ./cmd/cheasee-pi/...
```

### 1e — Go Tests

```bash
cd /workspaces/main && go test ./cmd/cheasee-pi/...
```

### 1f — GoReleaser Check

```bash
cd /workspaces/main && goreleaser check
```

---

## Step 2 — Verify Git State

```bash
cd /workspaces/main
git branch --show-current                     # must be main
git status --porcelain                        # must be empty
gh auth status                                # must be authenticated
```

---

## Step 3 — Fetch Last Tag

```bash
cd /workspaces/main && git fetch --tags origin
LAST_TAG=$(git tag --sort=-creatordate | head -1)
echo "Last tag: $LAST_TAG"
```

---

## Step 4 — Fetch + Process PRs (automated)

Run the two data scripts. This replaces manual PR-by-PR fetching and LLM categorization.

```bash
cd /workspaces/main

SCRIPT_DIR="/workspaces/main/.pi/skills/release-cheasee-pi/scripts"

# Fetch all merged PRs since last release
"$SCRIPT_DIR/fetch-prs.sh" "SchneiderDaniel/cheasee-pi" > ignore/release-data.json

# Categorize, calculate version, build release body
node "$SCRIPT_DIR/process-prs.mjs" < ignore/release-data.json > ignore/release-plan.json
```

Read `ignore/release-plan.json` and present the result to the user:

```bash
cat ignore/release-plan.json
```

**If `prCount` is 0:** no new PRs since last tag. STOP — nothing to release.

**If `tagExists` is true:** tag collision. STOP — delete existing tag first or abort.

---

## Step 5 — User Confirmation

Present the numbers from `release-plan.json`:

```
Last tag:    v{baseVersion}
PRs merged:  {prCount}
Features:    {featureCount}  (>=10 → +0.1, <10 → +0.01)
Increment:   {increment}
New version: v{newVersion}
```

Show first 5 rows of the proposed release body from `release-plan.json.body`.

Ask user:

> "Create release v{newVersion}?"
> Options: [Create] [Show full release body] [Cancel]

If Cancel → STOP. Do not create tag.

---

## Step 6 — Sync Version in All Files

```bash
node "$SCRIPT_DIR/sync-version.mjs" "{newVersion}" > ignore/sync-result.json
cat ignore/sync-result.json
```

Read `ignore/sync-result.json` and verify all 4 files were changed. If any file shows
`changed: false`, manually check and update it.

---

## Step 7 — Commit Version Bump

```bash
cd /workspaces/main
git add package.json cmd/cheasee-pi/root.go cmd/cheasee-pi/root_test.go docs/installation.md
git commit -m "chore: bump version to v{newVersion}"
```

---

## Step 8 — Create Tag

```bash
cd /workspaces/main
git tag -a "v{newVersion}" -m "Release v{newVersion}"
```

---

## Step 9 — Push Tag + Main

```bash
cd /workspaces/main
git push origin main
git push origin "v{newVersion}"
```

---

## Step 10 — Wait for GoReleaser CI

After the tag push, the GitHub Actions release workflow auto-triggers. Wait for it.

```bash
cd /workspaces/main
REPO="SchneiderDaniel/cheasee-pi"

RUN_ID=""
while [ -z "$RUN_ID" ]; do
  sleep 15
  RUN_ID=$(gh run list --repo "$REPO" --workflow "Release" --branch "v{newVersion}" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || echo "")
done

gh run watch "$RUN_ID" --repo "$REPO"
CONCLUSION=$(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq '.conclusion')

if [ "$CONCLUSION" = "success" ]; then
  echo "GoReleaser completed successfully."
else
  echo "WARNING: GoReleaser finished with status: $CONCLUSION"
  echo "Check: https://github.com/$REPO/actions/runs/$RUN_ID"
fi
```

---

## Step 11 — Update Release Body

GoReleaser creates the release with auto-generated changelog. Replace with our categorized body.

Save the body from `release-plan.json.body` to a temp file, then upload:

```bash
# Extract the body from release-plan.json
node -e "const d=require('./ignore/release-plan.json'); require('fs').writeFileSync('ignore/release-body.md', d.body)" 

gh release edit "v{newVersion}" --repo "SchneiderDaniel/cheasee-pi" --notes-file ignore/release-body.md
```

---

## Step 12 — Confirm + Clean Up

Print:

```
Release v{newVersion} published.
Tag:    v{newVersion}
URL:    https://github.com/SchneiderDaniel/cheasee-pi/releases/tag/v{newVersion}
Run:    https://github.com/SchneiderDaniel/cheasee-pi/actions/runs/{RUN_ID}

To roll back:
  git tag -d v{newVersion} && git push --delete origin v{newVersion} && git revert <commit-hash>
```

Clean up:

```bash
cd /workspaces/main
rm -f ignore/release-data.json ignore/release-plan.json ignore/sync-result.json ignore/release-body.md
```

---

## Constraints

- **Do NOT create tag if any check fails.** Hard stop.
- **Ask user before tag push.**
- Version sync must be consistent across all 4 files.
- **Do NOT use `gh release create`** — GoReleaser owns that.
- Use `gh` CLI for all GitHub operations.

## Quality Checklist

- [ ] Step 1: tsc, npm test, go build, go vet, go test, goreleaser check — all pass
- [ ] Step 2: on main, clean tree, gh authenticated
- [ ] Step 3: last tag identified (or empty state handled)
- [ ] Step 4: scripts fetched + processed all PRs (prCount > 0)
- [ ] Step 4: no tag collision (tagExists = false)
- [ ] Step 5: user confirmed
- [ ] Step 6: all 4 files synced (package.json, root.go, root_test.go, installation.md)
- [ ] Step 7: version bump committed
- [ ] Step 8-9: tag created and pushed
- [ ] Step 10: GoReleaser CI completed
- [ ] Step 11: release body updated (emoji headers, every PR linked, full changelog compare link)
- [ ] Step 12: temp files cleaned
