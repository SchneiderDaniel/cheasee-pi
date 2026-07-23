#!/bin/bash
set -e

# ------------------------------------------------------------------
# Cheasee-Pi entrypoint
#
# Remaps the non-root user `agentuser` to match the host UID/GID so
# that bind-mounted volumes have the correct ownership, then drops
# privileges via gosu and execs the provided command.
#
# Environment variables (all optional):
#   HOST_UID       – host user ID to map agentuser to
#   HOST_GID       – host group ID to map agentuser group to
#   HOST_GIT_NAME  – host git user.name (default: Cheasee-Pi)
#   HOST_GIT_EMAIL – host git user.email (default: cheasee-pi@localhost)
#   CHEASEEPI_CPUS – CPU limit (e.g. 4.0). Applied to cgroup directly
#                    because Docker Compose `cpus:` doesn't always apply
#                    reliably on all platforms.
# ------------------------------------------------------------------

HOST_UID="${HOST_UID:-}"

# --- Apply CPU limit from CHEASEEPI_CPUS to cgroup v2 ---------------
# Docker Compose `cpus:` at service level is silently ignored on some
# platforms. Writing directly to cpu.max guarantees the limit applies.
if [ -n "${CHEASEEPI_CPUS:-}" ]; then
    PERIOD=100000
    QUOTA=$(awk "BEGIN {printf %d, $CHEASEEPI_CPUS * $PERIOD}" 2>/dev/null)
    if [ -n "$QUOTA" ] && [ "$QUOTA" -gt 0 ] 2>/dev/null; then
        echo "$QUOTA $PERIOD" > /sys/fs/cgroup/cpu.max 2>/dev/null || \
            echo "Warning: could not write CPU limit to cgroup (non-fatal)"
    fi
fi
HOST_GID="${HOST_GID:-}"

# --- Auto-detect UID/GID from workspace mount if env not set ------
# Allows raw `docker compose up` to work without cheasee-pi.sh wrapper.
WORKSPACE_UID=$(stat -c '%u' /workspaces/main 2>/dev/null || echo "")
WORKSPACE_GID=$(stat -c '%g' /workspaces/main 2>/dev/null || echo "")

if [ -z "$HOST_UID" ] && [ -n "$WORKSPACE_UID" ] && [ "$WORKSPACE_UID" != "0" ]; then
    HOST_UID="$WORKSPACE_UID"
    echo "Auto-detected HOST_UID=$HOST_UID from mount"
fi
if [ -z "$HOST_GID" ] && [ -n "$WORKSPACE_GID" ] && [ "$WORKSPACE_GID" != "0" ]; then
    HOST_GID="$WORKSPACE_GID"
    echo "Auto-detected HOST_GID=$HOST_GID from mount"
fi

# --- Remap UID ----------------------------------------------------
if [ -n "$HOST_UID" ] && [ "$HOST_UID" != "$(id -u agentuser)" ]; then
    usermod -u "$HOST_UID" agentuser
fi

# --- Remap GID ----------------------------------------------------
if [ -n "$HOST_GID" ] && [ "$HOST_GID" != "$(id -g agentuser)" ]; then
    # If a group with the target GID already exists (e.g. the old
    # agentuser group), groupmod it silently.
    groupmod -g "$HOST_GID" agentuser 2>/dev/null || true
    usermod -g "$HOST_GID" agentuser
fi

# --- Fix git worktree paths for container portability -----------------
# Worktree .git files contain absolute host paths (e.g.
# /home/user/git/.bare/worktrees/...) that don't exist inside the
# container. Rewrite them to relative paths so git works regardless
# of mount point.
#
# Uses the unbreak_worktrees() function from worktree-fix.sh which
# idempotently rewrites paths, recovers pruned registrations, and
# locks worktrees to prevent future pruning. Runs on every container
# start but is fast because it skips already-relative paths.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/worktree-fix.sh
source "$SCRIPT_DIR/lib/worktree-fix.sh"
unbreak_worktrees

# --- Start pi-guardian orphan reaper -----------------------------------
# pi-guardian runs as PID 1 to detect and kill orphaned pi processes
# left by disconnected docker exec sessions. It reaps orphans every 30s.
PI_GUARDIAN_PID=""
if command -v pi-guardian &>/dev/null; then
    pi-guardian &
    PI_GUARDIAN_PID=$!
    echo "pi-guardian started (pid=$PI_GUARDIAN_PID)"
fi

# Trap for graceful shutdown: forward signals to pi-guardian
cleanup_guardian() {
    if [ -n "$PI_GUARDIAN_PID" ] && kill -0 "$PI_GUARDIAN_PID" 2>/dev/null; then
        echo "Shutting down pi-guardian (pid=$PI_GUARDIAN_PID)…"
        kill -TERM "$PI_GUARDIAN_PID" 2>/dev/null
        sleep 2
        kill -0 "$PI_GUARDIAN_PID" 2>/dev/null && kill -KILL "$PI_GUARDIAN_PID" 2>/dev/null || true
    fi
}
trap cleanup_guardian EXIT TERM INT

# --- Pre-install Python venvs for web tools -------------------------
# Copy pre-built venvs from /opt/venvs/ to .pi/ if missing.
# This saves first-call latency in web_search and web_crawl extensions.
if [ -d /opt/venvs/web-search-venv ] && [ ! -d /workspaces/main/.pi/web-search-venv ]; then
    echo "Pre-installing web-search venv…"
    mkdir -p /workspaces/main/.pi
    cp -a /opt/venvs/web-search-venv /workspaces/main/.pi/web-search-venv
fi
if [ -d /opt/venvs/scrapling-venv ] && [ ! -d /workspaces/main/.pi/scrapling-venv ]; then
    echo "Pre-installing scrapling venv…"
    mkdir -p /workspaces/main/.pi
    cp -a /opt/venvs/scrapling-venv /workspaces/main/.pi/scrapling-venv
fi
# Symlink Playwright browser cache so agentuser finds Chromium
if [ -d /opt/playwright-browsers ]; then
    mkdir -p /home/agentuser/.cache
    ln -sf /opt/playwright-browsers /home/agentuser/.cache/ms-playwright 2>/dev/null || true
fi

# --- Update file ownership ----------------------------------------
# Ensure the workspace and home directory are owned by the (possibly
# remapped) user so bind-mounted volumes are writable.
# Only chown if ownership mismatch — avoids full workspace scan on subsequent starts
AGENT_UID=$(id -u agentuser)
AGENT_GID=$(id -g agentuser)
WORKSPACE_OWNER=$(stat -c '%u:%g' /workspaces/main 2>/dev/null || echo "")

if [ "$WORKSPACE_OWNER" != "$AGENT_UID:$AGENT_GID" ]; then
    echo "Fixing /workspaces/main ownership to agentuser ($AGENT_UID:$AGENT_GID)..."
    chown -R agentuser:agentuser /workspaces/main || echo "Warning: chown /workspaces/main failed (non-fatal)"
fi

# Home dir is small — always ensure correct ownership
chown -R agentuser:agentuser /home/agentuser || echo "Warning: chown /home/agentuser failed (non-fatal)"

# --- Set git identity for agentuser --------------------------------------
# Required by supervisor extension (git commit). The commit author email
# IS the push-attribution identity: GitHub maps it to a GitHub account and
# credits the push to that account. A fake/empty email (e.g. "t@t.t") can't
# be mapped, so attribution falls back to the token holder → wrong author.
# cheasee-pi.sh resolves a verified identity (settings.json gitIdentity or
# gh-derived <id>+<login>@users.noreply.github.com) before passing it here.
GIT_NAME="${HOST_GIT_NAME:-Cheasee-Pi}"
GIT_EMAIL="${HOST_GIT_EMAIL:-cheasee-pi@localhost}"
gosu agentuser git config --global user.name "$GIT_NAME" 2>/dev/null || true
gosu agentuser git config --global user.email "$GIT_EMAIL" 2>/dev/null || true

# --- Rewrite SSH remote URLs to HTTPS for Docker --------------------------
# Docker image has no SSH client. gh CLI is installed with an HTTPS OAuth
# token passed via bind-mount (~/.config/gh). Use git insteadOf to
# transparently rewrite SSH GitHub URLs to HTTPS so git push works without
# SSH. This is a global git config — does not modify the repo's .git/config.
#
# Equivalent to: git remote set-url origin https://github.com/org/repo.git
# but without touching the shared working tree .git/config.
gosu agentuser git config --global --add url."https://github.com/".insteadOf "git@github.com:" 2>/dev/null || true
# Also handle SSH-style without colon (rare, but covers edge cases)
gosu agentuser git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" 2>/dev/null || true
# Use gh as credential helper for HTTPS pushes
gosu agentuser git config --global credential.helper "!/usr/bin/gh auth git-credential" 2>/dev/null || true

# --- Install workspace npm dependencies if missing -------------------
# The workspace is a bind-mount from the host; node_modules is local to the
# container and must be installed at runtime. Skip if already present so
# subsequent container starts are fast.
if [ ! -d /workspaces/main/node_modules ]; then
    echo "Installing workspace npm dependencies…"
    gosu agentuser bash -c 'cd /workspaces/main && npm install --no-audit --no-fund' \
        || echo "Warning: npm install failed (non-fatal — pi may still work depending on which extensions are loaded)"
fi

# --- Drop privileges and exec -------------------------------------
if [ $# -eq 0 ]; then
    # No command → fall through to interactive shell (debug mode)
    exec gosu agentuser /bin/bash
fi

exec gosu agentuser "$@"
