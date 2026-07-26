#!/usr/bin/env bash
set -uo pipefail

# Delete all remote branches on SchneiderDaniel/cheasee-pi except main
# Usage: ./scripts/clean-branches.sh [--dry-run]

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# grep exits 1 when no match — don't let that kill the script
branches=$(gh api repos/SchneiderDaniel/cheasee-pi/branches --paginate --jq '.[].name' | grep -v '^main$' || true)

if [[ -z "$branches" ]]; then
  echo "No branches to clean (only main exists)."
  exit 0
fi

count=0
while IFS= read -r branch; do
  if $DRY_RUN; then
    echo "[DRY-RUN] would delete: $branch"
  else
    if gh api -X DELETE "repos/SchneiderDaniel/cheasee-pi/git/refs/heads/$branch" --silent 2>/dev/null; then
      echo "✓ deleted: $branch"
    else
      echo "✗ failed: $branch" >&2
    fi
  fi
  ((count++))
done <<< "$branches"

echo "Done. $count branches processed."

