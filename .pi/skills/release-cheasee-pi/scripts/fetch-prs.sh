#!/usr/bin/env bash
# Fetch all merged PRs since last release tag.
# Outputs JSON to stdout: { lastTag, baseVersion, releaseDate, prs: [{number, title, url, mergedAt}] }
set -euo pipefail

REPO="${1:-SchneiderDaniel/cheasee-pi}"

# Get last tag
LAST_TAG=$(git tag --sort=-creatordate | head -1 || echo "")
if [ -z "$LAST_TAG" ]; then
  echo '{"lastTag":"","baseVersion":"0.1","releaseDate":"","prs":[]}'
  exit 0
fi

BASE_VERSION="${LAST_TAG#v}"

# Get release date from GitHub
RELEASE_DATE=$(gh release view "$LAST_TAG" --repo "$REPO" --json createdAt --jq '.createdAt' 2>/dev/null || echo "")

if [ -n "$RELEASE_DATE" ]; then
  # Single API call — fetch all merged PRs since that date
  PRS=$(gh pr list --repo "$REPO" --state merged --search "merged:>=$RELEASE_DATE" --limit 200 \
    --json number,title,mergedAt \
    --jq '[.[] | {number: (.number | tostring), title, url: ("https://github.com/'"$REPO"'/pull/" + (.number | tostring)), mergedAt}]' 2>/dev/null || echo "[]")
else
  # Fallback: extract from git merge commits
  PR_NUMS=$(git log "$LAST_TAG"..HEAD --oneline --grep="Merge pull request" | grep -oP 'Merge pull request #\K\d+' || echo "")
  if [ -z "$PR_NUMS" ]; then
    echo "{\"lastTag\":\"$LAST_TAG\",\"baseVersion\":\"$BASE_VERSION\",\"releaseDate\":\"$RELEASE_DATE\",\"prs\":[]}"
    exit 0
  fi

  PRS="["
  FIRST=true
  while read -r NUM; do
    [ -z "$NUM" ] && continue
    TITLE=$(gh pr view "$NUM" --repo "$REPO" --json title --jq '.title' 2>/dev/null || echo "unknown")
    MERGED_AT=$(gh pr view "$NUM" --repo "$REPO" --json mergedAt --jq '.mergedAt' 2>/dev/null || echo "")
    if [ "$FIRST" = true ]; then FIRST=false; else PRS+=","; fi
    PRS+="{\"number\":\"$NUM\",\"title\":$(echo "$TITLE" | jq -Rs '.'),\"url\":\"https://github.com/$REPO/pull/$NUM\",\"mergedAt\":\"$MERGED_AT\"}"
  done <<< "$PR_NUMS"
  PRS+="]"
fi

# Build output JSON
jq -n \
  --arg lastTag "$LAST_TAG" \
  --arg baseVersion "$BASE_VERSION" \
  --arg releaseDate "${RELEASE_DATE:-}" \
  --argjson prs "$PRS" \
  '{lastTag: $lastTag, baseVersion: $baseVersion, releaseDate: $releaseDate, prs: $prs}'
