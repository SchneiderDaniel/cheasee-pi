#!/usr/bin/env bash
# Cheasee-Pi standalone uninstaller — the mirror of scripts/install.sh.
# Works with or without the binary present. Removes:
#   1. the binary (candidates: /usr/local/bin, ~/.local/bin, PATH hits;
#      symlink-resolved, go-build/tmp paths skipped)
#   2. the whole cache parent <UserCacheDir>/cheasee-pi/ (all version keys)
#   3. the auth config <UserConfigDir>/cheasee-pi/auth.json
#
# Workspace files (.pi/, .git/, source checkouts) are never touched.
#
# Usage:
#   curl -fsL https://raw.githubusercontent.com/SchneiderDaniel/cheasee-pi/main/scripts/uninstall.sh | bash
#   bash scripts/uninstall.sh [--force] [--dry-run]
#
# Flags (meaningful when run from a file — under `curl | bash` stdin is the
# script stream, so the confirmation prompt is skipped automatically):
#   --force       skip the confirmation prompt
#   --dry-run     print the deletion list and exit without deleting
#   env NONINTERACTIVE=1 skips the prompt (same as --force)
set -euo pipefail

FORCE=0
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# Running as root via sudo: sudoers env_reset sets HOME=/root, so resolve the
# invoking user's home — root's own cache/config must never be the target.
# (Inspection-only path: CI runners are non-root; macOS lacks getent, so fall
# back to tilde expansion.)
if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  if command -v getent >/dev/null 2>&1; then
    HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  else
    HOME="$(eval echo "~$SUDO_USER")"
  fi
fi

# --- user dir resolution (mirrors Go's os.UserCacheDir/UserConfigDir) ----
# Darwin keeps state under ~/Library; other Unix honors $XDG_* with
# ~/.cache / ~/.config fallback. Every reference is ${VAR:-} so
# `env -u HOME ...` cannot trip set -u.
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"

user_cache_dir() {
  if [ "$OS" = "darwin" ]; then
    printf '%s' "${HOME:-}/Library/Caches"
  elif [ -n "${XDG_CACHE_HOME:-}" ]; then
    printf '%s' "$XDG_CACHE_HOME"
  elif [ -n "${HOME:-}" ]; then
    printf '%s' "$HOME/.cache"
  else
    printf '%s' ""
  fi
}

user_config_dir() {
  if [ "$OS" = "darwin" ]; then
    printf '%s' "${HOME:-}/Library/Application Support"
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    printf '%s' "$XDG_CONFIG_HOME"
  elif [ -n "${HOME:-}" ]; then
    printf '%s' "$HOME/.config"
  else
    printf '%s' ""
  fi
}

# --- binary detection ------------------------------------------------------
# Portable full symlink resolution (BSD readlink lacks -f).
resolve_link() {
  local target="$1" prev=""
  while [ -L "$target" ] && [ "$target" != "$prev" ]; do
    prev="$target"
    target="$(readlink "$target" 2>/dev/null || true)"
    [ -n "$target" ] || break
    case "$target" in
      /*) ;;
      *) target="$(dirname "$prev")/$target" ;;
    esac
  done
  printf '%s\n' "$target"
}

# add_binary adds the resolved real file (and, when it differs, the candidate
# path itself so a dangling symlink does not survive) — skipping go-build/tmp
# paths, deduping along the way.
binaries=()
add_binary() {
  local c="$1" resolved
  resolved="$(resolve_link "$c")"
  case "$resolved" in
    *"/go-build"* | *"/tmp/go"*) return 0 ;;
  esac
  local p
  for p in "${binaries[@]}"; do
    [ "$p" = "$resolved" ] && return 0
  done
  binaries+=("$resolved")
  if [ "$c" != "$resolved" ]; then
    for p in "${binaries[@]}"; do
      [ "$p" = "$c" ] && return 0
    done
    binaries+=("$c")
  fi
}

collect_binaries() {
  local c
  for c in "/usr/local/bin/cheasee-pi" "${HOME:-}/.local/bin/cheasee-pi"; do
    if [ -n "$c" ] && { [ -e "$c" ] || [ -L "$c" ]; }; then
      add_binary "$c"
    fi
  done
  if command -v cheasee-pi >/dev/null 2>&1; then
    add_binary "$(command -v cheasee-pi)"
  fi
}

# --- build the deletion list ------------------------------------------------
tree_targets=()   # removed with rm -fr (dirs)
file_targets=()   # removed with rm -f (auth config)

cache_base="$(user_cache_dir)"
if [ -n "$cache_base" ]; then
  cache_parent="$cache_base/cheasee-pi"
  if [ -e "$cache_parent" ]; then tree_targets+=("$cache_parent"); fi
fi

config_base="$(user_config_dir)"
if [ -n "$config_base" ]; then
  auth_path="$config_base/cheasee-pi/auth.json"
  if [ -e "$auth_path" ]; then file_targets+=("$auth_path"); fi
fi

collect_binaries

if [ "${#tree_targets[@]}" -eq 0 ] && [ "${#file_targets[@]}" -eq 0 ] && [ "${#binaries[@]}" -eq 0 ]; then
  echo "Nothing to remove — cheasee-pi is not installed." >&2
  exit 0
fi

echo "The following will be removed:" >&2
for p in "${tree_targets[@]}"; do echo "  will remove $p" >&2; done
for p in "${file_targets[@]}"; do echo "  will remove $p" >&2; done
for p in "${binaries[@]}"; do echo "  will remove $p" >&2; done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "  (dry run — nothing removed)" >&2
  exit 0
fi

# TTY-gated confirmation: under `curl | bash` stdin is the script stream, so a
# read prompt would consume script bytes or hit EOF — skip it. --force and
# NONINTERACTIVE=1 skip the prompt too (Homebrew's pattern).
if [ "$FORCE" -ne 1 ] && [ "${NONINTERACTIVE:-0}" != "1" ] && [ -t 0 ]; then
  printf 'Permanently remove these files and directories? [y/N] ' >&2
  read -r answer || answer=""
  case "${answer:-}" in
    y | Y | yes | YES) ;;
    *)
      echo "Uninstall cancelled." >&2
      exit 0
      ;;
  esac
fi

# --- removal ----------------------------------------------------------------
# Run unprivileged; elevate only for the /usr/local/bin removal (whole-script
# `sudo bash uninstall.sh` would delete root's state under sudoers env_reset).
failed=0
for p in "${tree_targets[@]}"; do
  if rm -fr -- "$p" 2>/dev/null; then
    echo "  ✓ Removed $p" >&2
  else
    echo "  ⚠ failed to remove $p" >&2
    failed=1
  fi
done

for p in "${file_targets[@]}"; do
  if rm -f -- "$p" 2>/dev/null; then
    echo "  ✓ Removed $p" >&2
  else
    echo "  ⚠ failed to remove $p" >&2
    failed=1
  fi
done

for p in "${binaries[@]}"; do
  if rm -f -- "$p" 2>/dev/null; then
    echo "  ✓ Removed $p" >&2
  elif command -v sudo >/dev/null 2>&1 && sudo rm -f -- "$p" 2>/dev/null; then
    echo "  ✓ Removed $p" >&2
  else
    echo "  ⚠ failed to remove $p" >&2
    echo "    To remove manually: sudo rm $p" >&2
    failed=1
  fi
done

# Best-effort: drop the now-empty config parent (Go parity).
if [ -n "${config_base:-}" ]; then
  rmdir "$config_base/cheasee-pi" 2>/dev/null || true
fi

if [ "$failed" -eq 1 ]; then
  echo "  ⚠ Partially uninstalled — rerun to retry the remaining paths." >&2
  exit 1
fi
echo "✅ Uninstall complete." >&2
