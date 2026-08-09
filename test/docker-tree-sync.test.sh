#!/usr/bin/env bash
# test/docker-tree-sync.test.sh
#
# Verifies the single-canonical-docker-tree consolidation (issue #1465):
#   - canonical source: cmd/cheasee-pi/embedded/docker/ (required by //go:embed)
#   - repo-root docker/ is a regenerated build artifact (make docker-tree /
#     make check-docker); docker/-only extras (test/, docker-compose.legacy.yml)
#     stay tracked and untouched
#
# Phase 1: Makefile sync targets (docker-tree / check-docker) — real FS
#
# NOTE: Phase 1 deliberately deletes and regenerates the shared docker/ files to
# prove regen works. Do NOT run this script concurrently with the tracked
# docker/test/*.test.mts suites — they exec docker/run-pi.sh / stop-pi.sh, and a
# test hitting the rm→regen window gets bash exit 127 ("script not found").
# (CI is safe: embed-sync.yml runs only read-only make check-docker.)
# Phase 2: embed integrity (Go)
# Phase 3: Git hygiene (.gitignore + git index)
# Phase 4: CI + docs wiring
# Phase 5: docker/ convenience-script regression (no Docker daemon needed)
# (Full Docker build e2e runs in CI: .github/workflows/cli-install-smoke.yml)
#
# Run:
#   bash test/docker-tree-sync.test.sh
#   bash test/docker-tree-sync.test.sh && go test ./cmd/cheasee-pi/ -count=1

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="cmd/cheasee-pi/embedded/docker"
SHARED_RELS=(Dockerfile docker-compose.yml entrypoint.sh \
	codeflow/Dockerfile codeflow/config.json codeflow/server.py \
	lib/auth-env.sh lib/worktree-fix.sh)

PASS=0
FAIL=0

pass() { echo "ok: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# run_expect <exit-code> <description> <cmd...>
run_expect() {
	local expected="$1"; shift
	local desc="$1"; shift
	set +e
	"$@" >/tmp/dtree-sync.out 2>/tmp/dtree-sync.err
	local got=$?
	set -e
	if [ "$got" -eq "$expected" ]; then
		pass "$desc"
	else
		fail "$desc (exit $got, want $expected; stderr: $(head -c 300 /tmp/dtree-sync.err | tr '\n' ' '))"
	fi
}

# run_fail <description> <cmd...> — asserts non-zero exit
run_fail() {
	local desc="$1"; shift
	set +e
	"$@" >/tmp/dtree-sync.out 2>/tmp/dtree-sync.err
	local got=$?
	set -e
	if [ "$got" -ne 0 ]; then
		pass "$desc"
	else
		fail "$desc (expected non-zero exit)"
	fi
}

# Restore sync state: undo any drift mutations to the embedded tree, regen docker/.
restore() {
	git checkout -- "$SRC" 2>/dev/null || true
	make docker-tree >/dev/null 2>&1 || true
}
trap restore EXIT

echo "== Phase 1: Makefile sync targets (docker-tree / check-docker) =="

# 1. clean-state regen: delete the 10 shared files, regen, verify byte-identical
rm -f "${SHARED_RELS[@]/#/docker/}"
run_expect 0 "docker-tree regenerates all shared files from clean state" make docker-tree
for rel in "${SHARED_RELS[@]}"; do
	if ! cmp -s "$SRC/$rel" "docker/$rel"; then
		fail "regen: docker/$rel not byte-identical to $SRC/$rel"
	fi
done
[ "$FAIL" -eq 0 ] && pass "regen: all 10 shared files byte-identical (incl. lib/auth-env.sh, lib/worktree-fix.sh)"

# 2. idempotency: second run exits 0, still in sync
run_expect 0 "docker-tree is idempotent (second run exits 0)" make docker-tree

# 3. check pass after regen
run_expect 0 "check-docker passes after regen" make check-docker

# 4. exec bits match source modes (entrypoint 0644; run-pi.sh/stop-pi.sh
#    were removed in the #1493 repo-mount restructure)
if [ ! -x docker/entrypoint.sh ]; then
	pass "exec bits: entrypoint.sh 0644 (run-pi.sh/stop-pi.sh removed in #1493)"
else
	fail "exec bits mismatch: $(ls -l docker/entrypoint.sh | awk '{print $1, $NF}')"
fi

# 5. drift: append to embedded Dockerfile -> check-docker fails, names file, suggests make docker-tree
echo "# drift" >> "$SRC/Dockerfile"
set +e
make check-docker >/tmp/dtree-sync.out 2>/tmp/dtree-sync.err
got=$?
set -e
if [ "$got" -ne 0 ] && grep -q "Dockerfile" /tmp/dtree-sync.err && grep -q "make docker-tree" /tmp/dtree-sync.err; then
	pass "drift: check-docker exits non-zero, names file, suggests make docker-tree"
else
	fail "drift: exit=$got stderr=$(head -c 300 /tmp/dtree-sync.err | tr '\n' ' ')"
fi
restore

# 6. missing: rm docker/docker-compose.yml -> check-docker fails
rm -f docker/docker-compose.yml
run_fail "missing: check-docker fails when docker/docker-compose.yml deleted" make check-docker
restore

# 7. lib/ coverage: drift in embedded lib/worktree-fix.sh is caught (old check-embed blind spot)
echo "# drift" >> "$SRC/lib/worktree-fix.sh"
run_fail "lib/ coverage: check-docker catches drift in embedded lib/worktree-fix.sh" make check-docker
restore

# 8. empty-source boundary: zero-match walk fails check-docker, leaves docker/ untouched
mv "$SRC" "${SRC}.dtree-bak"
run_fail "empty-source: check-docker fails when source walk matches nothing" make check-docker
[ -f docker/docker-compose.yml ] && pass "empty-source: docker/ left untouched" || fail "empty-source: docker/ was modified"
mv "${SRC}.dtree-bak" "$SRC"

# 9. docker/-only extras preserved; codeflow/ + lib/ recreated when removed
extra_files="docker/docker-compose.legacy.yml $(git ls-files docker/test/ | tr '\n' ' ')"
before=""
for f in $extra_files; do before="$before $(cksum < "$f")"; done
rm -rf docker/codeflow docker/lib
make docker-tree >/dev/null
after=""
for f in $extra_files; do after="$after $(cksum < "$f")"; done
if [ "$before" = "$after" ]; then
	pass "extras preserved: make docker-tree never touches test/** or docker-compose.legacy.yml"
else
	fail "extras changed by docker-tree (before: $before / after: $after)"
fi
[ -f docker/codeflow/Dockerfile ] && [ -f docker/lib/auth-env.sh ] \
	&& pass "regen recreates docker/codeflow/ and docker/lib/" \
	|| fail "regen did not recreate docker/codeflow/ or docker/lib/"

# 10. build decoupled: make build works with docker/ shared files deleted (no embed dep)
rm -f "${SHARED_RELS[@]/#/docker/}"
run_expect 0 "build decoupled: make build succeeds with docker/ shared files deleted" make build
rm -f cheasee-pi
restore

# 11. git-clean outcome: no untracked/modified entries under docker/ after regen
#     (staged D entries are this change's consolidation diff — expected;
#     tracked docker/ extras — test/, docker-compose.legacy.yml — may legitimately
#     carry working changes and are excluded)
if git status --porcelain docker/ | grep -Ev '^D |^ M docker/test/|^ M docker/docker-compose\.legacy\.yml' | grep -Eq '^\?\?|^ M|^A '; then
	fail "git-clean: unexpected entries under docker/: $(git status --porcelain docker/ | tr '\n' ' ')"
else
	pass "git-clean: no untracked/modified entries under docker/ after regen"
fi

echo "== Phase 2: embed integrity (Go) =="

run_expect 0 "go build ./cmd/cheasee-pi/ compiles (//go:embed embedded only)" go build -o /tmp/dtree-bin ./cmd/cheasee-pi/
run_expect 0 "go test ./cmd/cheasee-pi/ passes (FSExtractor intact)" go test ./cmd/cheasee-pi/ -count=1
rm -f /tmp/dtree-bin

echo "# drift" >> "$SRC/Dockerfile"
run_fail "test-embed gates on check-docker (fails on drift before go test)" make test-embed
restore

if grep -q "go:generate" cmd/cheasee-pi/embed.go; then
	fail "embed.go still contains a //go:generate line"
else
	pass "embed.go has no //go:generate line"
fi
if grep -q "Synced from docker/" cmd/cheasee-pi/embed.go; then
	fail "embed.go still claims synced-from-docker"
else
	pass "embed.go has no stale 'Synced from docker/' comment"
fi

echo "== Phase 3: Git hygiene =="

ignored_count=$(printf '%s\n' "${SHARED_RELS[@]/#/docker/}" | git check-ignore --stdin | wc -l)
if [ "$ignored_count" -eq "${#SHARED_RELS[@]}" ]; then
	pass "git check-ignore matches all ${#SHARED_RELS[@]} shared paths"
else
	fail "git check-ignore matched $ignored_count/${#SHARED_RELS[@]} paths"
fi

extra_tracked=$(git ls-files docker/ | grep -Ev '^(docker/docker-compose\.legacy\.yml|docker/test/.*)$' || true)
if [ -z "$extra_tracked" ]; then
	pass "git ls-files docker/ lists only docker-compose.legacy.yml + test/**"
else
	fail "generated files still tracked: $extra_tracked"
fi

if printf '.env\n' | git check-ignore --stdin -q; then
	pass ".env still ignored"
else
	fail ".env no longer ignored"
fi
if [ -n "$(git ls-files docker/test/)" ]; then
	pass "docker/test/** still tracked"
else
	fail "docker/test/** no longer tracked"
fi

echo "== Phase 4: CI + docs wiring =="

WF=.github/workflows/embed-sync.yml
if [ -f "$WF" ]; then pass "embed-sync.yml exists"; else fail "embed-sync.yml missing"; fi
if grep -q 'cmd/cheasee-pi/embedded/docker/\*\*' "$WF" 2>/dev/null; then pass "embed-sync triggers on embedded/docker/**"; else fail "embed-sync missing embedded/docker/** trigger"; fi
if grep -q '"Makefile"' "$WF" 2>/dev/null && grep -q '"\.gitignore"' "$WF" 2>/dev/null; then pass "embed-sync triggers on Makefile + .gitignore"; else fail "embed-sync missing Makefile/.gitignore triggers"; fi
if grep -q 'make check-docker' "$WF" 2>/dev/null; then pass "embed-sync runs make check-docker"; else fail "embed-sync does not run make check-docker"; fi

SMOKE=.github/workflows/cli-install-smoke.yml
stale=0
for p in 'docker/Dockerfile' 'docker/docker-compose.yml' 'docker/entrypoint.sh' 'docker/run-pi.sh' 'docker/stop-pi.sh' 'docker/lib/**'; do
	if grep -Fq "\"$p\"" "$SMOKE" 2>/dev/null; then
		fail "cli-install-smoke still triggers on generated $p"
		stale=1
	fi
done
[ "$stale" -eq 0 ] && pass "cli-install-smoke no longer triggers on generated docker/ paths"
if grep -q 'docker/test/cli-install-smoke.test.mts' "$SMOKE" 2>/dev/null; then pass "cli-install-smoke keeps docker/test trigger"; else fail "cli-install-smoke lost docker/test trigger"; fi
if grep -q 'cmd/cheasee-pi/\*\*' "$SMOKE" 2>/dev/null; then pass "cli-install-smoke covers embedded edits via cmd/cheasee-pi/**"; else fail "cli-install-smoke missing cmd/cheasee-pi/** trigger"; fi

if grep -rn "single source of truth" Makefile docs/ 2>/dev/null | grep -q "docker/Dockerfile"; then
	fail "stale 'single source of truth is docker/Dockerfile' wording remains"
else
	pass "no stale docker/Dockerfile-as-source wording in Makefile/docs"
fi
if grep -q 'make docker-tree' docs/architecture.md; then
	pass "docs: make docker-tree documented in architecture.md"
else
	fail "docs: make docker-tree missing from architecture.md"
fi

echo "== Phase 5: docker/ convenience-script regression (no Docker daemon) =="

# run-pi.sh/stop-pi.sh were removed in the #1493 repo-mount restructure — the
# CLI (cheasee-pi start/down) replaces them, so docker-convenience-scripts.test.mts
# was deleted with them. No convenience-script regression remains here.

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
