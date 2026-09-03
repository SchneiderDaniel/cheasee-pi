#!/usr/bin/env bash
# scripts/verify-pi-layer-cache.sh
#
# Phase 2 (e2e) verification for issue #1603 — "Move pi-coding-agent install
# to end of Dockerfile so pi updates rebuild only the pi layer".
#
# Asserts the Docker layer-cache behavior of the reordered Dockerfile:
#
#   build 1:  cheasee-pi build              (warms the cache)
#   build 2:  cheasee-pi build              (PI_BUILD_STAMP differs → pi layer re-runs)
#             → clone / npm ci / symlink RUN layers report CACHED   (AC1)
#             → pi install RUN does NOT report CACHED (stamp bust works, AC4)
#   build 3:  entrypoint.sh byte change (via extractor re-write) -> build
#             → pi install RUN reports CACHED                        (AC3)
#             → clone / npm ci still CACHED                          (AC1)
#             → entrypoint COPY re-runs (bytes changed)
#   boot:     docker run --rm cheasee-pi pi --version  → version printed     (AC5)
#             stamp file present in the final image                          (AC4)
#
# Scope: the cache-hit guarantee holds ONLY for default builds. --prune /
# --no-cache / --pull wipe the cache by design, and the floating
# FROM debian:12-slim digest drift is the upper bound on any pi-only rebuild.
#
# The stamp is second-granular (build.go: fmt.Sprintf("%d", time.Now().Unix())),
# so the script sleeps >= 1s between builds — same-second runs produce an
# identical ARG and a full cache hit that proves nothing.
#
# Requires: cheasee-pi on PATH (or CHEASEE_PI_BIN=/path/to/cheasee-pi), a
# working docker daemon, go toolchain (build 3 re-embeds the entrypoint
# change), ~15-25 min. Run manually — never inside a CI/Auditor timebox.
#
# Usage: bash scripts/verify-pi-layer-cache.sh [workspace-dir]
#        (workspace-dir defaults to this repo's root; must be a git repo)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="${1:-$REPO_ROOT}"
CLI="${CHEASEE_PI_BIN:-cheasee-pi}"
ENTRYPOINT_SRC="$REPO_ROOT/cmd/cheasee-pi/embedded/docker/entrypoint.sh"

command -v "$CLI" >/dev/null 2>&1 || { echo "error: cheasee-pi CLI not found on PATH (set CHEASEE_PI_BIN)" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "error: docker not found" >&2; exit 1; }
command -v go >/dev/null 2>&1 || { echo "error: go not found (needed to rebuild the CLI with the entrypoint change for build 3)" >&2; exit 1; }
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- cmd/cheasee-pi/embedded/docker/entrypoint.sh)" ]]; then
  echo "error: entrypoint.sh has uncommitted changes — refusing to touch it (build 3 modifies then git-restores it)" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# ──────────────────────────────────────────────
# Build-log helpers. Two formats occur depending on who prints the progress:
#   compose v2 non-TTY:  "=> [5/8] RUN git clone ..."   then "=> [5/8] CACHED"
#   buildx non-TTY:      "#9 [5/8] RUN git clone ..."   then "#9 CACHED"
# Both carry the "[n/m]" bracket on the header line, so we locate steps by
# bracket and accept either outcome form.
# ──────────────────────────────────────────────

# step_bracket <log> <command-regex ERE> → the "[n/m]" label of the first step
# whose printed command line matches. Empty when the step never ran.
step_bracket() {
  local log=$1 pat=$2
  grep -E "$pat" "$log" 2>/dev/null | grep -oE '\[[0-9]+/[0-9]+\]' | head -n1 || true
}

# step_outcome <log> <bracket> <CACHED|DONE> → 0 when the step reports that
# outcome in either log format.
step_outcome() {
  local log=$1 bracket=$2 outcome=$3 n
  grep -F "$bracket $outcome" "$log" | grep -q . && return 0
  n="$(grep -F "$bracket" "$log" | grep -oE '^#[0-9]+' | head -n1 || true)"
  [[ -n "$n" ]] && grep -F "$n $outcome" "$log" | grep -q .
}

# assert_cached <log> <label> <command-regex ERE>
assert_cached() {
  local log=$1 label=$2 pat=$3 bracket
  bracket="$(step_bracket "$log" "$pat")"
  if [[ -z "$bracket" ]]; then
    echo "  ✗ $label: step not found in build log (pattern: $pat)" >&2
    return 1
  fi
  if step_outcome "$log" "$bracket" CACHED; then
    echo "  ✓ $label: CACHED"
  else
    echo "  ✗ $label: NOT cached (step $bracket) — expected a cache hit" >&2
    grep -F "$bracket" "$log" >&2 || true
    return 1
  fi
}

# assert_rerun <log> <label> <command-regex ERE> — the step re-executed
# (reports DONE, not CACHED).
assert_rerun() {
  local log=$1 label=$2 pat=$3 bracket
  bracket="$(step_bracket "$log" "$pat")"
  if [[ -z "$bracket" ]]; then
    echo "  ✗ $label: step not found in build log (pattern: $pat)" >&2
    return 1
  fi
  if step_outcome "$log" "$bracket" CACHED; then
    echo "  ✗ $label: CACHED but expected to re-execute (step $bracket)" >&2
    return 1
  fi
  # compose's non-TTY summary prints executed steps as "[n/m] RUN <cmd> <dur>"
  # with no separate DONE line; only buildx prints "#N DONE". A step line
  # without CACHED in a completed build is a re-execution either way.
  if step_outcome "$log" "$bracket" DONE || grep -q 'FINISHED' "$log"; then
    echo "  ✓ $label: re-executed (no CACHED, build finished)"
  else
    echo "  ✗ $label: neither CACHED nor a completed build (step $bracket)" >&2
    grep -F "$bracket" "$log" >&2 || true
    return 1
  fi
}

build() { # <out-log> — runs `cheasee-pi build` (default flags) in WORKDIR
  (cd "$WORKDIR" && "$CLI" build) 2>&1 | tee "$1"
}

failures=0
fail() { echo "  ✗ $1" >&2; failures=$((failures + 1)); }

clone_pat='RUN git clone --depth 1 --branch ${CHEASEE_REF}'
symlink_pat='RUN mkdir -p /home/agentuser/.pi/agent/skills'
pi_pat='RUN npm install -g --force @earendil-works/pi-coding-agent'
copy_pat='COPY entrypoint.sh /usr/local/bin/entrypoint.sh'

echo "== build 1 (warm the cache) =="
build "$TMP/build1.log"
sleep 1 # stamp is second-granular — same-second builds would cache-hit entirely

echo "== build 2 (same sources, new PI_BUILD_STAMP) =="
build "$TMP/build2.log"
echo "— AC1: expensive 6b layers stay cached on a pi-only rebuild —"
assert_cached "$TMP/build2.log" "clone + npm ci (6b)" "$clone_pat" || fail "clone/npm-ci layer must be CACHED on build 2"
assert_cached "$TMP/build2.log" "symlink wiring (6b)" "$symlink_pat" || fail "symlink layer must be CACHED on build 2"
echo "— AC4: stamp bust still re-runs the pi install —"
assert_rerun "$TMP/build2.log" "pi install (6c)" "$pi_pat" || fail "pi layer must re-execute on build 2 (stamp bust)"

echo "== build 3 (entrypoint.sh byte change → extractor re-writes it) =="
# Emulate an entrypoint-only release: append a marker to the embedded source,
# rebuild the CLI (the extractor re-writes the cache dir's entrypoint.sh from
# the new binary on `cheasee-pi build`), then restore the source.
printf '\n# verify-pi-layer-cache.sh marker\n' >>"$ENTRYPOINT_SRC"
restore_entrypoint() { git -C "$REPO_ROOT" checkout -- cmd/cheasee-pi/embedded/docker/entrypoint.sh 2>/dev/null || true; }
trap 'restore_entrypoint; rm -rf "$TMP"' EXIT
(cd "$REPO_ROOT" && go build -o "$TMP/cheasee-pi" ./cmd/cheasee-pi/)
restore_entrypoint
CLI="$TMP/cheasee-pi" build "$TMP/build3.log"
echo "— AC3: entrypoint-only change must NOT reinstall pi —"
assert_cached "$TMP/build3.log" "pi install (6c)" "$pi_pat" || fail "pi layer must be CACHED on build 3 (entrypoint-only change)"
assert_cached "$TMP/build3.log" "clone + npm ci (6b)" "$clone_pat" || fail "clone/npm-ci layer must stay CACHED on build 3"
assert_rerun "$TMP/build3.log" "entrypoint COPY (7)" "$copy_pat" || fail "entrypoint COPY must re-execute on build 3 (bytes changed)"

echo "== boot checks =="
if docker run --rm cheasee-pi pi --version; then
  echo "  ✓ docker run --rm cheasee-pi pi --version (AC5)"
else
  fail "image must boot: docker run --rm cheasee-pi pi --version"
fi
if docker run --rm cheasee-pi sh -c 'test -f /var/lib/pi-build-stamp'; then
  echo "  ✓ stamp file /var/lib/pi-build-stamp present in the final image (AC4)"
else
  fail "stamp file /var/lib/pi-build-stamp missing from the final image"
fi

echo
if [[ $failures -eq 0 ]]; then
  echo "PASS: pi layer is incremental — pi updates no longer rebuild clone + npm ci."
  exit 0
fi
echo "FAIL: $failures assertion(s) failed" >&2
exit 1