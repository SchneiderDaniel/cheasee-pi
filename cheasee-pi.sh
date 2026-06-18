#!/bin/bash
set -e

# ------------------------------------------------------------------
# Cheasee-Pi — Docker Compose orchestration wrapper
#
# Single entry point to build, start, and enter the cheasee-pi
# container with workspace mounts and resource limits configured
# via the project's settings file.
#
# Usage:
#   ./cheasee-pi.sh
# ------------------------------------------------------------------

# --- Step 1: Assert docker is on PATH ---------------------------------
if ! command -v docker &>/dev/null; then
    echo "Error: Docker not found on PATH."
    echo "Install Docker from: https://docs.docker.com/get-docker/"
    echo ""
    echo "After installing, ensure your user is in the 'docker' group:"
    echo "  sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
fi

# --- Step 2: Read resource limits from .pi/settings.json --------------
if ! command -v jq &>/dev/null; then
    echo "Error: jq is required but not found on PATH."
    echo "Install from: https://jqlang.github.io/jq/download/"
    exit 1
fi

CHEASEEPI_MEMORY=$(jq -r '.docker.memory // "4G"' .pi/settings.json)
CHEASEEPI_CPUS=$(jq -r '.docker.cpus // "2.0"' .pi/settings.json)

export CHEASEEPI_MEMORY
export CHEASEEPI_CPUS

# --- Step 4: Export host identity -------------------------------------
export HOST_UID
HOST_UID=$(id -u)
export HOST_GID
HOST_GID=$(id -g)

# --- Step 5: Start (or rebuild) the container -------------------------
echo "Starting cheasee-pi container..."
docker compose -f docker/docker-compose.yml up -d --build

# --- Step 6: Launch interactive pi session ----------------------------
echo "Entering pi agent inside container..."
# Use the startup wrapper which integrates the splash loading screen
# setupSplashIntegration() patches DefaultResourceLoader before main() runs
docker exec -it cheasee-pi /bin/bash -c 'cd /workspaces/main && node --experimental-strip-types src/start-pi.ts "$@"' --
