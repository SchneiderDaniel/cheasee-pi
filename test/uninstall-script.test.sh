#!/usr/bin/env bash
# test/uninstall-script.test.sh
#
# Adapter tests for the standalone scripts/uninstall.sh (issue #1510).
#
# Every run gets a fresh temp HOME + XDG_CACHE_HOME + XDG_CONFIG_HOME + PATH,
# so real user state can never be touched. The suite aborts if EUID=0 (the
# partial-failure injection relies on non-root permission errors).
#
# Run: bash test/uninstall-script.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SCRIPT="$ROOT/scripts/uninstall.sh"

if [ "$(id -u)" -eq 0 ]; then
  echo "Aborting: this test must not run as root (fixtures rely on non-root permission failures)." >&2
  exit 1
fi

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

TMP_DIRS=()
cleanup() { rm -rf "${TMP_DIRS[@]:-}"; }
trap cleanup EXIT

# Pristine PATH: sandbox bins are prepended per test, never accumulated.
ORIG_PATH="$PATH"

new_dir() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  printf '%s\n' "$d"
}

# build_fixture <sandbox> — creates a fake full install state and exports
# fresh HOME/XDG_*/PATH pointing into the sandbox (in the calling shell; do
# not wrap in command substitution).
build_fixture() {
  local sandbox="$1"
  mkdir -p "$sandbox/home" "$sandbox/cache" "$sandbox/config" "$sandbox/bin"
  export HOME="$sandbox/home"
  export XDG_CACHE_HOME="$sandbox/cache"
  export XDG_CONFIG_HOME="$sandbox/config"
  export PATH="$sandbox/bin:$ORIG_PATH"
  # cache parent with two version keys (script removes the whole parent)
  mkdir -p "$XDG_CACHE_HOME/cheasee-pi/0.49" "$XDG_CACHE_HOME/cheasee-pi/0.50"
  # auth config
  mkdir -p "$XDG_CONFIG_HOME/cheasee-pi"
  printf '{}\n' > "$XDG_CONFIG_HOME/cheasee-pi/auth.json"
  # binary on PATH (outside the two install dirs → command -v hit)
  printf '#!/bin/sh\necho fake\n' > "$sandbox/bin/cheasee-pi"
  chmod +x "$sandbox/bin/cheasee-pi"
}

assert_gone() {
  local path="$1" desc="$2"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then pass "$desc"; else fail "$desc ($path still exists)"; fi
}

assert_present() {
  local path="$1" desc="$2"
  if [ -e "$path" ] || [ -L "$path" ]; then pass "$desc"; else fail "$desc ($path missing)"; fi
}

echo "== uninstall.sh: adapter layer =="

# --- happy path, --force ---------------------------------------------------
t_force() {
  local sandbox workdir
  sandbox="$(new_dir)"
  build_fixture "$sandbox"
  workdir="$sandbox/workdir"
  mkdir -p "$workdir/.pi" "$workdir/.git"
  printf '{}\n' > "$workdir/cheasee-settings.json"
  local out
  out="$(bash "$SCRIPT" --force 2>&1)"
  local rc=$?
  if [ "$rc" -eq 0 ]; then pass "--force happy path exits 0"; else fail "--force happy path exits 0 (got $rc): $out"; fi
  assert_gone "$XDG_CACHE_HOME/cheasee-pi" "whole cache parent removed (both version keys)"
  assert_gone "$XDG_CONFIG_HOME/cheasee-pi/auth.json" "auth.json removed"
  assert_gone "$sandbox/bin/cheasee-pi" "binary removed"
  assert_present "$workdir/.pi" ".pi/ retained (workspace never touched)"
  assert_present "$workdir/.git" ".git/ retained (workspace never touched)"
  assert_present "$workdir/cheasee-settings.json" "cheasee-settings.json retained"
}
t_force

# --- --dry-run --------------------------------------------------------------
t_dry_run() {
  local sandbox workdir out
  sandbox="$(new_dir)"
  build_fixture "$sandbox"
  out="$(bash "$SCRIPT" --dry-run --force 2>&1)"
  local rc=$?
  if [ "$rc" -eq 0 ]; then pass "--dry-run exits 0"; else fail "--dry-run exits 0 (got $rc)"; fi
  local cache_parent="$XDG_CACHE_HOME/cheasee-pi"
  local auth_path="$XDG_CONFIG_HOME/cheasee-pi/auth.json"
  for target in "$cache_parent" "$auth_path" "$sandbox/bin/cheasee-pi"; do
    if printf '%s\n' "$out" | grep -Fq "  will remove $target"; then
      pass "--dry-run lists $target"
    else
      fail "--dry-run lists $target (missing from output)"
    fi
  done
  assert_present "$cache_parent/0.49" "--dry-run deletes nothing (cache)"
  assert_present "$auth_path" "--dry-run deletes nothing (auth.json)"
  assert_present "$sandbox/bin/cheasee-pi" "--dry-run deletes nothing (binary)"
}
t_dry_run

# --- TTY-gate regression (piped stdin = script stream) ----------------------
t_piped_stdin() {
  local sandbox out rc
  sandbox="$(new_dir)"
  build_fixture "$sandbox"
  local out rc
  set +e
  out="$(cat "$SCRIPT" | bash 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then pass "cat script | bash completes without hang (exit 0)"; else fail "cat script | bash (got $rc)"; fi
  assert_gone "$XDG_CACHE_HOME/cheasee-pi" "piped run removes cache parent"
}
t_piped_stdin

# --- prompt: --force / NONINTERACTIVE skip it; 'n' cancels ------------------
t_prompt() {
  if ! command -v script >/dev/null 2>&1; then
    echo "  (skipped: 'script' not available)"
    return 0
  fi
  # 'n' on a pty → cancelled, nothing deleted
  local sandbox out rc
  sandbox="$(new_dir)"
  build_fixture "$sandbox"
  set +e
  out="$(printf 'n\n' | script -qec "bash \"$SCRIPT\"" /dev/null 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then pass "prompt 'n' exits 0"; else fail "prompt 'n' exits 0 (got $rc)"; fi
  if printf '%s\n' "$out" | grep -Fq "Uninstall cancelled."; then
    pass "prompt 'n' prints 'Uninstall cancelled.'"
  else
    fail "prompt 'n' prints 'Uninstall cancelled.'"
  fi
  assert_present "$XDG_CACHE_HOME/cheasee-pi" "prompt 'n' deletes nothing (cache)"

  # NONINTERACTIVE=1 on a pty → prompt skipped, deletion proceeds
  sandbox="$(new_dir)"
  build_fixture "$sandbox"
  set +e
  out="$(printf 'n\n' | NONINTERACTIVE=1 script -qec "bash \"$SCRIPT\"" /dev/null 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ] && [ ! -e "$XDG_CACHE_HOME/cheasee-pi" ]; then
    pass "NONINTERACTIVE=1 skips the prompt (deletes despite 'n' on stdin)"
  else
    fail "NONINTERACTIVE=1 skips the prompt (rc=$rc, cache exists: $([ -e "$XDG_CACHE_HOME/cheasee-pi" ] && echo yes || echo no))"
  fi
}
t_prompt

# --- partial failure --------------------------------------------------------
t_partial_failure() {
  local sandbox out rc
  sandbox="$(new_dir)"
  build_fixture "$sandbox"
  # Make auth.json a non-empty dir → rm -f (file semantics) must fail
  rm "$XDG_CONFIG_HOME/cheasee-pi/auth.json"
  mkdir "$XDG_CONFIG_HOME/cheasee-pi/auth.json"
  touch "$XDG_CONFIG_HOME/cheasee-pi/auth.json/blocker"
  set +e
  out="$(bash "$SCRIPT" --force 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then pass "partial failure exits non-zero (got $rc)"; else fail "partial failure exits non-zero (got 0)"; fi
  if printf '%s\n' "$out" | grep -Fq "⚠ failed to remove"; then
    pass "partial failure reports the residual"
  else
    fail "partial failure reports the residual"
  fi
  assert_present "$XDG_CONFIG_HOME/cheasee-pi/auth.json" "failed target left in place"
  assert_gone "$XDG_CACHE_HOME/cheasee-pi" "other targets still removed (cache)"
  assert_gone "$sandbox/bin/cheasee-pi" "other targets still removed (binary)"
}
t_partial_failure

# --- nothing installed ------------------------------------------------------
t_nothing_installed() {
  local sandbox out rc
  sandbox="$(new_dir)"
  export HOME="$sandbox/home" XDG_CACHE_HOME="$sandbox/cache" XDG_CONFIG_HOME="$sandbox/config"
  export PATH="$sandbox/bin:$ORIG_PATH"
  mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$sandbox/bin"
  set +e
  out="$(bash "$SCRIPT" --force 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then pass "nothing installed exits 0"; else fail "nothing installed exits 0 (got $rc)"; fi
  if printf '%s\n' "$out" | grep -Fqi "nothing to remove"; then
    pass "nothing installed reports 'nothing to remove'"
  else
    fail "nothing installed reports 'nothing to remove'"
  fi

  # set -u hardening: no unbound-variable errors with env vars stripped
  set +e
  out="$(env -u HOME -u XDG_CACHE_HOME -u XDG_CONFIG_HOME bash "$SCRIPT" --dry-run --force 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then pass "env -u HOME ... runs clean (exit 0)"; else fail "env -u HOME ... (got $rc): $out"; fi
  if printf '%s\n' "$out" | grep -Fq "unbound variable"; then
    fail "no unbound-variable errors under set -u"
  else
    pass "no unbound-variable errors under set -u"
  fi
}
t_nothing_installed

# --- binary detection: symlinks, command -v, go-build/tmp skip, dedup -------
t_binary_detection() {
  # symlinked binary: real file resolved and removed (link too)
  local sandbox out rc
  sandbox="$(new_dir)"
  build_fixture "$sandbox"
  mkdir -p "$sandbox/real-bin"
  printf '#!/bin/sh\n' > "$sandbox/real-bin/cheasee-pi"
  chmod +x "$sandbox/real-bin/cheasee-pi"
  ln -sf "$sandbox/real-bin/cheasee-pi" "$sandbox/bin/cheasee-pi"
  set +e
  out="$(bash "$SCRIPT" --force 2>&1)"
  rc=$?
  set -e
  assert_gone "$sandbox/real-bin/cheasee-pi" "symlinked binary resolved and real file removed"
  assert_gone "$sandbox/bin/cheasee-pi" "symlink itself removed"
  if [ "$rc" -eq 0 ]; then pass "symlink run exits 0"; else fail "symlink run exits 0 (got $rc)"; fi

  # go-build and /tmp/go paths are skipped
  for go_path in "$HOME/go-build" "$HOME/tmp/go"; do
    sandbox="$(new_dir)"
    build_fixture "$sandbox"
    rm "$sandbox/bin/cheasee-pi"
    mkdir -p "$go_path"
    printf '#!/bin/sh\n' > "$go_path/cheasee-pi"
    chmod +x "$go_path/cheasee-pi"
    set +e
    out="$(PATH="$go_path:$ORIG_PATH" bash "$SCRIPT" --dry-run --force 2>&1)"
    rc=$?
    set -e
    if printf '%s\n' "$out" | grep -Fq "will remove $go_path/cheasee-pi"; then
      fail "go-build/tmp path skipped ($go_path)"
    else
      pass "go-build/tmp path skipped ($go_path)"
    fi
    if [ "$rc" -eq 0 ]; then pass "skip run exits 0"; else fail "skip run exits 0 (got $rc)"; fi
  done

  # duplicate candidates deduped to one list entry
  sandbox="$(new_dir)"
  build_fixture "$sandbox"
  rm "$sandbox/bin/cheasee-pi"
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\n' > "$HOME/.local/bin/cheasee-pi"
  chmod +x "$HOME/.local/bin/cheasee-pi"
  set +e
  out="$(PATH="$HOME/.local/bin:$ORIG_PATH" bash "$SCRIPT" --dry-run --force 2>&1)"
  rc=$?
  set -e
  local count
  count="$(printf '%s\n' "$out" | grep -Fc "  will remove $HOME/.local/bin/cheasee-pi" || true)"
  if [ "$count" -eq 1 ]; then
    pass "duplicate candidates deduped to one list entry"
  else
    fail "duplicate candidates deduped to one list entry (got $count entries)"
  fi
}
t_binary_detection

# --- workspace files are never touched --------------------------------------
t_workspace_untouched() {
  # Running from inside a workspace must leave .pi/ and .git/ alone.
  local sandbox out rc
  sandbox="$(new_dir)"
  build_fixture "$sandbox"
  mkdir -p "$sandbox/ws/.pi" "$sandbox/ws/.git"
  set +e
  out="$(cd "$sandbox/ws" && bash "$SCRIPT" --force 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then pass "run from workspace exits 0"; else fail "run from workspace exits 0 (got $rc): $out"; fi
  assert_present "$sandbox/ws/.pi" "workspace .pi/ untouched"
  assert_present "$sandbox/ws/.git" "workspace .git/ untouched"
  if printf '%s\n' "$out" | grep -Fq ".pi"; then
    fail "deletion list never mentions .pi/"
  else
    pass "deletion list never mentions .pi/"
  fi
}
t_workspace_untouched

# --- paths with spaces + XDG fallback ---------------------------------------
t_spaces() {
  local sandbox out rc
  sandbox="$(new_dir)/sandbox with spaces"
  mkdir -p "$sandbox/home dir" "$sandbox/cache dir/cheasee-pi/0.50" "$sandbox/config dir/cheasee-pi" "$sandbox/bin dir"
  export HOME="$sandbox/home dir"
  export XDG_CACHE_HOME="$sandbox/cache dir"
  export XDG_CONFIG_HOME="$sandbox/config dir"
  export PATH="$sandbox/bin dir:$ORIG_PATH"
  printf '{}\n' > "$XDG_CONFIG_HOME/cheasee-pi/auth.json"
  printf '#!/bin/sh\n' > "$sandbox/bin dir/cheasee-pi"
  chmod +x "$sandbox/bin dir/cheasee-pi"
  set +e
  out="$(bash "$SCRIPT" --force 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then pass "paths with spaces handled (exit 0)"; else fail "paths with spaces handled (got $rc): $out"; fi
  assert_gone "$XDG_CACHE_HOME/cheasee-pi" "spaced cache parent removed"
  assert_gone "$XDG_CONFIG_HOME/cheasee-pi/auth.json" "spaced auth.json removed"
  assert_gone "$sandbox/bin dir/cheasee-pi" "spaced binary removed"

  # XDG vars unset → $HOME/.cache and $HOME/.config fallback
  sandbox="$(new_dir)"
  export HOME="$sandbox/home"
  unset XDG_CACHE_HOME XDG_CONFIG_HOME
  mkdir -p "$HOME/.cache/cheasee-pi/0.50" "$HOME/.config/cheasee-pi"
  printf '{}\n' > "$HOME/.config/cheasee-pi/auth.json"
  set +e
  out="$(bash "$SCRIPT" --force 2>&1)"
  rc=$?
  set -e
  assert_gone "$HOME/.cache/cheasee-pi" "XDG unset → \$HOME/.cache fallback used"
  assert_gone "$HOME/.config/cheasee-pi" "XDG unset → \$HOME/.config fallback used"
}
t_spaces

# --- idempotency ------------------------------------------------------------
t_idempotent() {
  local sandbox out rc
  sandbox="$(new_dir)"
  build_fixture "$sandbox"
  bash "$SCRIPT" --force >/dev/null 2>&1
  set +e
  out="$(bash "$SCRIPT" --force 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then pass "second run exits 0"; else fail "second run exits 0 (got $rc)"; fi
  if printf '%s\n' "$out" | grep -Fqi "nothing to remove"; then
    pass "second run reports nothing to remove"
  else
    fail "second run reports nothing to remove"
  fi
}
t_idempotent

# --- user journey: the documented one-liner delivery shape ------------------
t_user_journey() {
  local sandbox out rc
  sandbox="$(new_dir)"
  build_fixture "$sandbox"
  set +e
  out="$(cat "$SCRIPT" | bash 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then pass "user journey: cat scripts/uninstall.sh | bash exits 0"; else fail "user journey exit 0 (got $rc)"; fi
  for needle in "will remove" "✓ Removed" "Uninstall complete."; do
    if printf '%s\n' "$out" | grep -Fq "$needle"; then
      pass "user journey: shows '$needle'"
    else
      fail "user journey: shows '$needle'"
    fi
  done
  assert_gone "$XDG_CACHE_HOME/cheasee-pi" "user journey: host fully clean (cache)"
  assert_gone "$XDG_CONFIG_HOME/cheasee-pi/auth.json" "user journey: host fully clean (auth.json)"
  assert_gone "$sandbox/bin/cheasee-pi" "user journey: host fully clean (binary)"
}
t_user_journey

echo
if [ "$FAIL" -eq 0 ]; then
  echo "uninstall-script: all $PASS checks passed"
  exit 0
else
  echo "uninstall-script: $FAIL checks FAILED ($PASS passed)"
  exit 1
fi
