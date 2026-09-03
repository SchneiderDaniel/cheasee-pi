#!/usr/bin/env bash
# scripts/verify-pi-layer-cache.sh
#
# Phase 2 (e2e) verification for issue #1603 — "Move pi-coding-agent install
# to end of Dockerfile so pi updates rebuild only the pi layer".
#
# Asserts the Docker layer-cache behavior of the reordered Dockerfile:
#
#   build 1:  cheasee-pi build    (real CLI path — warms the cache)
#   build 2:  compose build, stamp S2 held by the script (S2 != build 1's stamp)
#             → clone / npm ci / symlink RUN layers report CACHED   (AC1)
#             → pi install RUN does NOT report CACHED (stamp bust works, AC4)
#   build 3:  entrypoint.sh byte change (cache-dir context file) + compose build
#             with the SAME stamp S2 as build 2
#             → pi install RUN reports CACHED                        (AC3)
#             → clone / npm ci still CACHED                          (AC1)
#             → entrypoint COPY re-runs (bytes changed)
#   boot:     docker run --rm <project>-cheasee-pi pi --version → version printed (AC5)
#             stamp file present in the final image                          (AC4)
#
# WHY COMPOSE-DIRECT FOR BUILDS 2/3: `cheasee-pi build` always injects a
# fresh PI_BUILD_STAMP (build.go: fmt.Sprintf("%d", time.Now().Unix())) by
# design. AC3 (entrypoint-only change must not reinstall pi) is only testable
# when the stamp is HELD CONSTANT across builds 2→3, so those builds run
# through `docker compose build` directly with the script's own stamp. Build 1
# still exercises the real CLI path end-to-end.
#
# Scope: the cache-hit guarantee holds ONLY for default builds. --prune /
# --no-cache / --pull wipe the cache by design, and the floating
# FROM debian:12-slim digest drift is the upper bound on any pi-only rebuild.
#
# Requires: cheasee-pi on PATH (or CHEASEE_PI_BIN=/path/to/cheasee-pi), a
# working docker daemon, ~15-25 min. Run manually — never inside a CI/Auditor
# timebox. The compose/Dockerfile/entrypoint build context is the CLI's
# version-keyed cache dir (populated by build 1's extract), which the script
# resolves from `cheasee-pi --version`.
#
# Usage: bash scripts/verify-pi-layer-cache.sh [workspace-dir]
#        (workspace-dir defaults to this repo's root; must be a git repo)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKDIR="${1:-$REPO_ROOT}"
CLI="${CHEASEE_PI_BIN:-cheasee-pi}"

command -v "$CLI" >/dev/null 2>&1 || { echo "error: cheasee-pi CLI not found on PATH (set CHEASEE_PI_BIN)" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "error: docker not found" >&2; exit 1; }

# The compose build context lives in the CLI's version-keyed cache dir
# (cache.go: os.UserCacheDir()/cheasee-pi/<cliVersion>). Version from the
# CLI binary itself (--version → "cheasee-pi version 0.55.3"), so a custom
# CHEASEE_PI_BIN build resolves its own cache key.
CLI_VERSION="$("$CLI" --version | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+\.[0-9]+\.[0-9]+$/) print $i; exit }')"
if [[ -z "$CLI_VERSION" ]]; then
  echo "error: could not parse a semver from \`$CLI --version\` (got: $("$CLI" --version)) — cannot resolve the cache dir" >&2
  exit 1
fi
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/cheasee-pi/${CLI_VERSION}"
COMPOSE_FILE="$CACHE_DIR/docker-compose.yml"
# Compose project for the script's own builds — compose tags the image as
# <project>-cheasee-pi (the file's `name: cheasee-pi` and the CLI's per-repo
# project name produce different tags, so the boot check resolves the image
# dynamically instead of assuming a name).
PROJECT="cheasee-pi-cacheverify"

TMP="$(mktemp -d)"
ENTRYPOINT_CACHE="$CACHE_DIR/entrypoint.sh"
ENTRYPOINT_BAK="$TMP/entrypoint.sh.orig"
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

# compose_build <stamp> <out-log> — runs `docker compose build` directly with
# the given PI_BUILD_STAMP (default flags), from the CLI's cache-dir build
# context. Mirrors what build.go does for its compose argv (minus the CLI's
# own stamp injection, which is the point: AC3 needs the stamp held constant).
# Compose validates every volume spec even for `build`, so the workspace env
# vars must be set (same env application as applyComposeEnv).
compose_build() { # <stamp> <out-log>
  local stamp=$1 out=$2
  (cd "$CACHE_DIR" \
    && WORKSPACE_HOST_PATH="$WORKDIR" \
       WORKSPACE_BARE_PATH="$(dirname "$WORKDIR")/.bare" \
       COMPOSE_PROJECT_NAME="$PROJECT" \
       docker compose -f "$COMPOSE_FILE" build \
         --build-arg "PI_BUILD_STAMP=$stamp") 2>&1 | tee "$out"
}

failures=0
fail() { echo "  ✗ $1" >&2; failures=$((failures + 1)); }

clone_pat='RUN git clone --depth 1 --branch ${CHEASEE_REF}'
symlink_pat='RUN mkdir -p /home/agentuser/.pi/agent/skills'
pi_pat='RUN npm install -g --force @earendil-works/pi-coding-agent'
copy_pat='COPY entrypoint.sh /usr/local/bin/entrypoint.sh'

echo "== build 1 (warm the cache, real CLI path) =="
build "$TMP/build1.log"
sleep 1 # stamp is second-granular — build 2's held stamp must differ from build 1's CLI stamp

# The CLI's build-1 stamp was generated inside the binary; we cannot observe
# it. To guarantee build 2's stamp differs, derive it from the wall clock >=
# 1s later (sleep above). Builds 2 and 3 share this stamp: AC3 requires
# holding PI_BUILD_STAMP constant while only entrypoint bytes change.
STAMP2="$(date +%s)"

echo "== build 2 (same sources, new PI_BUILD_STAMP held by script) =="
compose_build "$STAMP2" "$TMP/build2.log"
echo "— AC1: expensive 6b layers stay cached on a pi-only rebuild —"
assert_cached "$TMP/build2.log" "clone + npm ci (6b)" "$clone_pat" || fail "clone/npm-ci layer must be CACHED on build 2"
assert_cached "$TMP/build2.log" "symlink wiring (6b)" "$symlink_pat" || fail "symlink layer must be CACHED on build 2"
echo "— AC4: stamp bust still re-runs the pi install —"
assert_rerun "$TMP/build2.log" "pi install (6c)" "$pi_pat" || fail "pi layer must re-execute on build 2 (stamp bust)"

echo "== build 3 (entrypoint.sh byte change, SAME PI_BUILD_STAMP as build 2) =="
# Emulate an entrypoint-only release by appending a marker to the build
# context's entrypoint.sh (the CLI cache-dir copy — the file Layer 7 COPYs
# into the image). Build through compose with the stamp held at STAMP2 so the
# pi layer's cache key (RUN text + ARG value) is byte-identical to build 2's:
# only the entrypoint COPY can differ. Restore the context file afterwards
# so the cache dir is left pristine.
cp "$ENTRYPOINT_CACHE" "$ENTRYPOINT_BAK"
restore_entrypoint() { cp "$ENTRYPOINT_BAK" "$ENTRYPOINT_CACHE" 2>/dev/null || true; }
trap 'restore_entrypoint; rm -rf "$TMP"' EXIT
printf '\n# verify-pi-layer-cache.sh marker\n' >>"$ENTRYPOINT_CACHE"
compose_build "$STAMP2" "$TMP/build3.log"
restore_entrypoint
# Build 3 done — the entrypoint context file is restored; relax the trap to
# only clean the temp dir (a later failure must not re-clobber a deliberately
# edited context).
trap 'rm -rf "$TMP"' EXIT
echo "— AC3: entrypoint-only change must NOT reinstall pi —"
assert_cached "$TMP/build3.log" "pi install (6c)" "$pi_pat" || fail "pi layer must be CACHED on build 3 (entrypoint-only change)"
assert_cached "$TMP/build3.log" "clone + npm ci (6b)" "$clone_pat" || fail "clone/npm-ci layer must stay CACHED on build 3"
assert_rerun "$TMP/build3.log" "entrypoint COPY (7)" "$copy_pat" || fail "entrypoint COPY must re-execute on build 3 (bytes changed)"

echo "== boot checks =="
# Compose tags the built image as <project>-cheasee-pi (no `image:` key in
# docker-compose.yml), so resolve it from the project instead of assuming
# the bare name `cheasee-pi`. `docker compose build` only builds; no
# containers exist, so `docker compose images` (which lists containers'
# images) would print nothing. Resolve via the compose project label, with
# the <project>-<service> name-scheme fallback.
IMAGE="$(docker image ls --filter label=com.docker.compose.project="$PROJECT" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | head -n1)"
if [[ -z "$IMAGE" ]]; then
  IMAGE="$(docker image ls --format '{{.Repository}}:{{.Tag}}' "${PROJECT}-cheasee-pi" 2>/dev/null | head -n1)"
fi
if [[ -z "$IMAGE" ]]; then
  echo "error: expected image from compose project $PROJECT was not built (docker image ls found nothing)" >&2
  fail "image ${PROJECT}-cheasee-pi must exist after compose build"
fi
if docker run --rm "$IMAGE" pi --version; then
  echo "  ✓ docker run --rm $IMAGE pi --version (AC5)"
else
  fail "image must boot: docker run --rm $IMAGE pi --version"
fi
if docker run --rm "$IMAGE" sh -c 'test -f /var/lib/pi-build-stamp'; then
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