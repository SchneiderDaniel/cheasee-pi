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
- `sync-version.mjs` — Update version string in all 4 files (exits non-zero if any file unchanged)
- `format-plan.mjs` — Print formatted release plan + prompt user (exit 0=create, 1=cancel, 2=show body)
- `run-checks.mjs` — Run all pre-release checks with failure snapshot comparison

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

Automated via script. Takes a snapshot of pre-existing failures so the release
isn't blocked by unrelated test rot.

```bash
cd /workspaces/main
SCRIPT_DIR="/workspaces/main/.pi/skills/release-cheasee-pi/scripts"

# First run: save snapshot of current failures as baseline
node "$SCRIPT_DIR/run-checks.mjs" ignore/check-baseline.json
```

If this fails, fix the issues before proceeding. Once baseline is saved,
re-running will only fail on NEW failures not in the snapshot.

Run again after version sync (Step 8) to verify no regressions:

```bash
node "$SCRIPT_DIR/run-checks.mjs" ignore/check-baseline.json
```

---

## Step 2 — Check Dependabot Alerts

Block release if any open Dependabot alerts exist. Must fix before releasing.

```bash
cd /workspaces/main
OPEN=$(gh api repos/SchneiderDaniel/cheasee-pi/dependabot/alerts --jq '[.[] | select(.state == "open")] | length')
if [ "$OPEN" -gt 0 ]; then
  echo "ERROR: $OPEN open Dependabot alert(s) found."
  echo "View and fix: https://github.com/SchneiderDaniel/cheasee-pi/security/dependabot"
  gh api repos/SchneiderDaniel/cheasee-pi/dependabot/alerts --jq '.[] | select(.state == "open") | "\(.number): \(.security_advisory.severity // "unknown") - \(.security_advisory.summary // .security_vulnerability.package.name)"'
  exit 1
fi
echo "OK: no open Dependabot alerts."
```

---

## Step 3 — Verify CI Checks

Check that all GitHub Actions workflows on main are green before releasing.

```bash
cd /workspaces/main
REPO="SchneiderDaniel/cheasee-pi"
FAILED=$(gh run list --repo "$REPO" --branch main --limit 5 --json name,conclusion --jq '[.[] | select(.conclusion != "success")] | length')
if [ "$FAILED" -gt 0 ]; then
  echo "ERROR: $FAILED recent workflow run(s) on main not successful."
  echo "Check: https://github.com/$REPO/actions?query=branch%3Amain"
  gh run list --repo "$REPO" --branch main --limit 5 --json name,conclusion --jq '.[] | "\(.name): \(.conclusion)"'
  exit 1
fi
echo "OK: last 5 workflow runs on main all green."
```

---

## Step 4 — Verify Git State

```bash
cd /workspaces/main
git branch --show-current                     # must be main
git status --porcelain                        # must be empty
gh auth status                                # must be authenticated
```

---

## Step 5 — Fetch Last Tag

```bash
cd /workspaces/main && git fetch --tags origin
LAST_TAG=$(git tag --sort=-creatordate | head -1)
echo "Last tag: $LAST_TAG"
```

---

## Step 6 — Fetch + Process PRs (automated)

Run the two data scripts. This replaces manual PR-by-PR fetching and LLM categorization.

```bash
cd /workspaces/main

SCRIPT_DIR="/workspaces/main/.pi/skills/release-cheasee-pi/scripts"

# Fetch all merged PRs since last release
"$SCRIPT_DIR/fetch-prs.sh" "SchneiderDaniel/cheasee-pi" > ignore/release-data.json

# Categorize, calculate version, build release body
node "$SCRIPT_DIR/process-prs.mjs" < ignore/release-data.json > ignore/release-plan.json
```

## Step 7 — User Confirmation

```bash
node "$SCRIPT_DIR/format-plan.mjs" < ignore/release-plan.json
```

Exit codes:
- **0** → user confirmed. Proceed.
- **1** → cancelled. STOP.
- **2** → user requested full body (printed to stderr). Re-run to confirm.

> **Version format:** Scripts output 2-part version (`MAJOR.MINOR`). Go tests accept both 2-part and 3-part, but GoReleaser archive naming uses bare tag version. Keep 2-part everywhere.

---

## Step 8 — Sync Version in All Files

```bash
node "$SCRIPT_DIR/sync-version.mjs" "{newVersion}" > ignore/sync-result.json
cat ignore/sync-result.json
```

Script exits non-zero if any file wasn't updated. If it fails, check which file
wasn't matched and update `sync-version.mjs` regex patterns.

---

## Step 9 — Commit Version Bump

```bash
cd /workspaces/main
git add package.json cmd/cheasee-pi/root.go cmd/cheasee-pi/root_test.go docs/installation.md
git commit -m "chore: bump version to v{newVersion}"
```

---

## Step 10 — Create Tag

```bash
cd /workspaces/main
git tag -a "v{newVersion}" -m "Release v{newVersion}"
```

---

## Step 11 — Push Tag + Main

```bash
cd /workspaces/main
git push origin main
git push origin "v{newVersion}"
```

---

## Step 12 — Wait for GoReleaser CI

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

## Step 13 — Update Release Body

GoReleaser creates the release with auto-generated changelog. Replace with our categorized body.

Save the body from `release-plan.json.body` to a temp file, then upload:

```bash
# Extract the body from release-plan.json
node -e "const d=require('./ignore/release-plan.json'); require('fs').writeFileSync('ignore/release-body.md', d.body)" 

gh release edit "v{newVersion}" --repo "SchneiderDaniel/cheasee-pi" --notes-file ignore/release-body.md
```

---

## Step 14 — Confirm + Clean Up

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

- [ ] Step 1: `run-checks.mjs` baseline saved (exit 0 or baseline-only failures)
- [ ] Step 2: no open Dependabot alerts
- [ ] Step 3: last 5 CI workflow runs on main are green
- [ ] Step 4: on main, clean tree, gh authenticated
- [ ] Step 5: last tag identified
- [ ] Step 6: `process-prs.mjs` produced `release-plan.json` — `prCount > 0`, `tagExists = false`
- [ ] Step 7: `format-plan.mjs` exited 0 (user confirmed)
- [ ] Step 8: `sync-version.mjs` exited 0 (all 4 files changed)
- [ ] Step 8: `run-checks.mjs` with baseline exits 0 (no regressions)
- [ ] Step 9: version bump committed
- [ ] Step 10-11: tag created and pushed
- [ ] Step 12: GoReleaser CI completed
- [ ] Step 13: release body updated
- [ ] Step 14: temp files cleaned
