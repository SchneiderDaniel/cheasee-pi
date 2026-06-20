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
# ------------------------------------------------------------------

HOST_UID="${HOST_UID:-}"
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
# Required by supervisor extension (git commit). Identity is just for local
# commits inside the container — push uses GitHub token, not this identity.
# Reads HOST_GIT_NAME / HOST_GIT_EMAIL passed from host (cheasee-pi.sh).
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

# --- Drop privileges and exec -------------------------------------
if [ $# -eq 0 ]; then
    # No command → fall through to interactive shell (debug mode)
    exec gosu agentuser /bin/bash
fi

exec gosu agentuser "$@"
