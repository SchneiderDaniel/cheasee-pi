#!/bin/bash
set -e

# ------------------------------------------------------------------
# stop-pi.sh — One-command container stop for cheasee-pi
#
# Stops and removes the cheasee-pi container via docker compose down.
# Uses `down` (not `stop`) so the container is removed, avoiding
# name collision on the next `run-pi.sh` start.
#
# Usage:
#   bash docker/stop-pi.sh
# ------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
echo "Stopping container cheasee-pi…"
docker compose down
