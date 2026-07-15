#!/bin/bash
set -e

# ------------------------------------------------------------------
# run-pi.sh — One-command session start for cheasee-pi
#
# Starts the container if not running, then execs into it and opens
# a pi TUI session. Idempotent: skips `up -d` if container already
# running.
#
# Usage:
#   bash docker/run-pi.sh
#
# Dependencies:
#   - Docker Engine running
#   - `cheasee-pi init` or `cheasee-pi.sh` run at least once
# ------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
CONTAINER_NAME="cheasee-pi"

# --- Source shared auth library ---
source "$SCRIPT_DIR/lib/auth-env.sh"

# --- Check if container already running ---
if docker ps --filter name="$CONTAINER_NAME" --format '{{.Names}}' 2>/dev/null | grep -q "$CONTAINER_NAME"; then
    echo "Container already running — attaching…"
else
    echo "Starting container $CONTAINER_NAME…"
    docker compose -f "$COMPOSE_FILE" up -d
fi

# --- Build env passthrough from auth.json (XDG path, with legacy fallback) ---
DOCKER_ENV=""
AUTH_JSON=$(resolve_auth_json)

if [ -n "$AUTH_JSON" ] && [ -f "$AUTH_JSON" ] && command -v jq &>/dev/null; then
    while IFS= read -r provider; do
        [ -z "$provider" ] && continue
        key=$(jq -r ".\"$provider\".key // empty" "$AUTH_JSON")
        if [ -n "$key" ]; then
            var=$(provider_to_envvar "$provider")
            if [ -n "$var" ]; then
                DOCKER_ENV="$DOCKER_ENV -e $var=$key"
            fi
        fi
    done <<< "$(jq -r 'keys[]' "$AUTH_JSON" 2>/dev/null)"
fi

# --- Extract gh token from host keyring ---
if [ -z "${GH_TOKEN:-}" ] && command -v gh &>/dev/null; then
    GH_TOKEN_EXTRACTED=$(gh auth token 2>/dev/null || true)
    if [ -n "$GH_TOKEN_EXTRACTED" ]; then
        DOCKER_ENV="$DOCKER_ENV -e GH_TOKEN=$GH_TOKEN_EXTRACTED"
    fi
    unset GH_TOKEN_EXTRACTED
fi

if [ -n "${GH_TOKEN:-}" ]; then
    DOCKER_ENV="$DOCKER_ENV -e GH_TOKEN=$GH_TOKEN"
fi

# --- Launch interactive pi session ---
# shellcheck disable=SC2086
docker exec $DOCKER_ENV -it --user agentuser -w /workspaces/main "$CONTAINER_NAME" pi
