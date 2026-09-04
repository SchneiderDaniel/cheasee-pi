#!/usr/bin/env bash
set -euo pipefail
# Phase 1: three tracked artifacts deleted from index
[ -z "$(git ls-files report/jscpd-report.json benchmarks/benchmark-tools.sh .initremove)" ] || { echo "FAIL: tracked artifact still in index"; exit 1; }
# Phase 1b: /report/ ignore rule persisted (both-halves check)
git check-ignore -q report/ || { echo "FAIL: /report/ ignore rule missing"; exit 1; }
[ -z "$(git diff --name-only HEAD -- .gitignore)" ] || { echo "FAIL: .gitignore modified"; exit 1; }
# Phase 2: git-invisible scaffold removed from filesystem
[ ! -e .pi/fix-sync-version-cache ] || { echo "FAIL: scaffold dir still present"; exit 1; }
# Phase 3a: no dangling references to deleted artifacts (rebase.test.mts jscpd strings are fixtures, allowed)
if rg -n "initremove|benchmark-tools" --hidden -g '!node_modules' -g '!.git' -g '!test/repo-hygiene-dead-artifacts.test.sh' .; then echo "FAIL: dangling reference found"; exit 1; fi
# Phase 3b: Go suite (acceptance gate)
go test ./... -count=1
# Phase 3c: targeted rebase regression guard (not in default npm test)
node --experimental-strip-types --test .pi/extensions/supervisor/test/pipeline/rebase.test.mts
# Phase 3d: full extension suite
npm test
echo "PASS: repo-hygiene deletion verified"