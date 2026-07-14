#!/bin/bash
# ------------------------------------------------------------------
# auth-env.sh — Auth JSON path resolution and provider→envvar mapping
#
# Shared library sourced by both cheasee-pi.sh and docker/run-pi.sh
# so that the auth.json→env mapping lives in exactly one place.
#
# Usage:
#   source docker/lib/auth-env.sh
#   AUTH_JSON=$(resolve_auth_json)
#   if [ -n "$AUTH_JSON" ]; then ... read provider keys from it ...
#
# Exports:
#   resolve_auth_json  — echoes path of first existing auth.json
#   provider_to_envvar — echoes the env var name for a provider
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
# provider_to_envvar — map a provider name to its env var name
#
# Usage:
#   envvar=$(provider_to_envvar "opencode-go")   # → OPENCODE_API_KEY
#
# Returns empty string for unknown providers.
# ─────────────────────────────────────────────────────────────────
provider_to_envvar() {
    case "$1" in
        opencode-go|opencode)  echo "OPENCODE_API_KEY" ;;
        openai*)               echo "OPENAI_API_KEY" ;;
        anthropic*|claude*)    echo "ANTHROPIC_API_KEY" ;;
        deepseek*)             echo "DEEPSEEK_API_KEY" ;;
        gemini*|google*)       echo "GEMINI_API_KEY" ;;
        groq*)                 echo "GROQ_API_KEY" ;;
        mistral*)              echo "MISTRAL_API_KEY" ;;
        openrouter*)           echo "OPENROUTER_API_KEY" ;;
        *)                     echo "" ;;
    esac
}
