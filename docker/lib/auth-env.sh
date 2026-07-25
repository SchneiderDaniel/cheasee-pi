#!/bin/bash
# ------------------------------------------------------------------
# auth-env.sh — Auth JSON path resolution and provider→envvar mapping
#
# Shared library sourced by both cheasee-pi.sh and docker/run-pi.sh
# so that the auth.json→env mapping lives in exactly one place.
#
# The provider→envvar mapping is derived from the canonical Go source
# via `cheasee-pi auth envvars`.  The shell no longer maintains a
# separate case block.
#
# Usage:
#   source docker/lib/auth-env.sh
#   AUTH_JSON=$(resolve_auth_json)
#   if [ -n "$AUTH_JSON" ]; then ... read provider keys from it ...
#
# Exports:
#   resolve_auth_json  — echoes path of first existing auth.json
#   ENV_MAP            — associative array provider→envvar (built once)
# ------------------------------------------------------------------

# ─────────────────────────────────────────────────────────────────
# resolve_auth_json — echo the path of the first existing auth.json
#
# Precedence:
#   1. $HOME/.config/cheasee-pi/auth.json   (XDG, new canonical path)
#   2. $HOME/.pi/agent/auth.json              (legacy, one-release fallback)
#
# Returns empty string if neither file exists.
# ─────────────────────────────────────────────────────────────────
resolve_auth_json() {
    local xdg_path="$HOME/.config/cheasee-pi/auth.json"
    local legacy_path="$HOME/.pi/agent/auth.json"

    if [ -f "$xdg_path" ]; then
        echo "$xdg_path"
    elif [ -f "$legacy_path" ]; then
        echo "$legacy_path"
    else
        echo ""
    fi
}

# ─────────────────────────────────────────────────────────────────
# ENV_MAP — associative array mapping provider name to env var name
#
# Built once from the canonical Go source via `cheasee-pi auth envvars`.
# Falls back to empty map if cheasee-pi is not on PATH (emits a warning).
# ─────────────────────────────────────────────────────────────────
declare -A ENV_MAP
if command -v cheasee-pi &>/dev/null; then
    # Read the mapping from the canonical source. Each line is
    # provider=ENV_VAR.  No secret values cross this boundary.
    while IFS='=' read -r provider envvar; do
        [ -z "$provider" ] && continue
        ENV_MAP["$provider"]="$envvar"
    done < <(cheasee-pi auth envvars 2>/dev/null || true)
fi
if [ ${#ENV_MAP[@]} -eq 0 ]; then
    echo "cheasee-pi: WARNING: provider env var mapping is empty (cheasee-pi auth envvars returned nothing)." >&2
fi
