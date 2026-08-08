#!/usr/bin/env bash
# test/no-submodules.test.sh
#
# Verifies the check-no-submodules guard (issue #1492): cheasee-pi is a single
# normal repo — no .gitmodules, no submodule gitlinks, no go-git, no
# submodule-aware code paths.
#
# Phase 1: clean-repo pass (guard exits 0 on the real repo)
# Phase 2: negative cases against temp git repos
#   - .gitmodules present → fail
#   - fake gitlink (git update-index --add --cacheinfo 160000) → fail
#   - go-git in go.mod → fail
#   - submodule token in a scanned code path → fail
#
# Run: bash test/no-submodules.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

run_expect() {
	local want="$1"; shift
	local desc="$1"; shift
	set +e
	"$@" >/tmp/no-submod.out 2>/tmp/no-submod.err
	local got=$?
	set -e
	if [ "$got" -eq "$want" ]; then
		pass "$desc"
	else
		fail "$desc (expected exit $want, got $got)"
	fi
}

echo "== Phase 1: guard passes on the clean repo =="
run_expect 0 "check-no-submodules passes on the real repo" bash scripts/check-no-submodules.sh

echo "== Phase 2: negative cases (temp repos) =="

tmp_a="$(mktemp -d)"
tmp_b="$(mktemp -d)"
tmp_c="$(mktemp -d)"
tmp_d="$(mktemp -d)"
trap 'rm -rf "$tmp_a" "$tmp_b" "$tmp_c" "$tmp_d"' EXIT

# 2a. .gitmodules present
touch "$tmp_a/.gitmodules"
set +e
(
	cd "$tmp_a"
	bash "$ROOT/scripts/check-no-submodules.sh" >/dev/null 2>&1
)
got=$?
set -e
if [ "$got" -eq 1 ]; then
	pass "guard fails when .gitmodules exists"
else
	fail "guard fails when .gitmodules exists (expected exit 1, got $got)"
fi

# 2b. fake gitlink in index
(
	cd "$tmp_b"
	git init -q
	git config user.email test@example.com
	git config user.name Test
	echo x > file.txt && git add file.txt && git commit -qm init
	git update-index --add --cacheinfo 160000,4b825dc642cb6eb9a060e54bf8d69288fbee4904,subrepo
)
set +e
(
	cd "$tmp_b"
	bash "$ROOT/scripts/check-no-submodules.sh" >/dev/null 2>&1
)
got=$?
set -e
if [ "$got" -eq 1 ]; then
	pass "guard fails on a 160000 gitlink in the index"
else
	fail "guard fails on a 160000 gitlink in the index (expected exit 1, got $got)"
fi

# 2c. go-git in go.mod
printf 'module test\n\ngo 1.25\n\nrequire github.com/go-git/go-git/v5 v5.19.2\n' > "$tmp_c/go.mod"
set +e
(
	cd "$tmp_c"
	bash "$ROOT/scripts/check-no-submodules.sh" >/dev/null 2>&1
)
got=$?
set -e
if [ "$got" -eq 1 ]; then
	pass "guard fails when go.mod requires go-git"
else
	fail "guard fails when go.mod requires go-git (expected exit 1, got $got)"
fi

# 2d. submodule token in a scanned path
mkdir -p "$tmp_d/cmd/cheasee-pi"
printf 'package main\n\n// submodule handling removed\nfunc main() {}\n' > "$tmp_d/cmd/cheasee-pi/main.go"
set +e
(
	cd "$tmp_d"
	bash "$ROOT/scripts/check-no-submodules.sh" >/dev/null 2>&1
)
got=$?
set -e
if [ "$got" -eq 1 ]; then
	pass "guard fails on a submodule token in cmd/"
else
	fail "guard fails on a submodule token in cmd/ (expected exit 1, got $got)"
fi

echo
if [ "$FAIL" -eq 0 ]; then
	echo "no-submodules: all $PASS checks passed"
	exit 0
else
	echo "no-submodules: $FAIL checks FAILED ($PASS passed)"
	exit 1
fi
