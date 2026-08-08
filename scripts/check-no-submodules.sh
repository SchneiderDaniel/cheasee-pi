#!/usr/bin/env bash
# scripts/check-no-submodules.sh
#
# Enforces the "single normal repo" invariant (issue #1492): cheasee-pi must
# never carry .gitmodules, submodule gitlinks, submodule bookkeeping, the
# go-git dependency, or submodule-aware code paths again.
#
# Fails when:
#   - .gitmodules exists in the worktree or index
#   - a 160000 gitlink is present in the index
#   - `git submodule status` is non-empty
#   - go-git remains in go.mod
#   - a "submodule" token appears in cmd/ (Go), supervisor/ non-test source,
#     docker/ non-test files, or .pi/settings.json
#
# Run: make check-no-submodules
set -euo pipefail

fail() {
	echo "check-no-submodules: FAIL: $1" >&2
	exit 1
}

[ -f .gitmodules ] && fail ".gitmodules exists — single normal repo invariant violated"

if git ls-files --stage 2>/dev/null | grep -q '^160000'; then
	fail "index contains a 160000 gitlink — submodule reintroduced"
fi

submodule_status="$(git submodule status 2>/dev/null || true)"
[ -n "$submodule_status" ] && fail "git submodule status is non-empty: $submodule_status"

if grep -q 'github.com/go-git/go-git' go.mod 2>/dev/null; then
	fail "go.mod still requires go-git (only used by the removed submodule subsystem)"
fi

# Submodule-aware code paths: cmd/ (Go), supervisor/ source, docker/ non-test
# files, .pi/settings.json. Test dirs/files are excluded so the intentional
# negative tests (stray submodules key, .gitmodules-on-disk fixture,
# TestFreshCloneNoSubmodules) can assert the token is *not* honored.
hits="$(grep -rin --include='*.go' --include='*.ts' --include='*.py' --include='*.yml' --include='*.yaml' --include='*.json' --include='*.sh' \
	-e 'submodule' \
	cmd/ \
	.pi/extensions/supervisor/ \
	docker/ \
	.pi/settings.json \
	2>/dev/null \
	| grep -v '^cmd/[^:]*_test\.go:' \
	| grep -v '^\.pi/extensions/supervisor/test/' \
	| grep -v '^docker/test/' || true)"
if [ -n "$hits" ]; then
	fail "submodule token found in tracked code paths:
$hits"
fi

echo "check-no-submodules: OK — single normal repo (no .gitmodules, no gitlinks, no submodule code paths)"
