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
# Uses sentinel file on bind mount so rewrite runs once per host path.
WORKTREE_SENTINEL="/workspaces/.cheasee-pi-worktrees-fixed"
if [ ! -f "$WORKTREE_SENTINEL" ]; then
    echo "Fixing git worktree paths in /workspaces..."
    find /workspaces -maxdepth 3 -name '.git' -type f 2>/dev/null | while read -r f; do
    read -r line < "$f"
    gitdir="${line#gitdir: }"
    [ "${gitdir:0:1}" != "/" ] && continue       # skip relative
    [ -d "$gitdir" ] && continue                  # already valid
    suffix="${gitdir#*/.bare}"
    echo "gitdir: ../.bare$suffix" > "$f"
    echo "Fixed: $f → ../.bare$suffix"
done

# Fix reciprocal gitdir files inside .bare/worktrees/<id>/gitdir
find /workspaces/.bare/worktrees -name 'gitdir' -type f 2>/dev/null | while read -r f; do
    read -r content < "$f"
    [ "${content:0:1}" != "/" ] && continue      # skip relative
    [ -f "$content" ] && continue                  # already valid
    worktree_id=$(basename "$(dirname "$f")")
    echo "../../$worktree_id/.git" > "$f"
    echo "Fixed: $f → ../../$worktree_id/.git"
done
    touch "$WORKTREE_SENTINEL"
    echo "Worktree paths fixed (sentinel: $WORKTREE_SENTINEL)"
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
# Required by supervisor extension (git commit). Identity is just for local
# commits inside the container — push uses GitHub token, not this identity.
# Reads HOST_GIT_NAME / HOST_GIT_EMAIL passed from host (cheasee-pi.sh).
GIT_NAME="${HOST_GIT_NAME:-Cheasee-Pi}"
GIT_EMAIL="${HOST_GIT_EMAIL:-cheasee-pi@localhost}"
gosu agentuser git config --global user.name "$GIT_NAME" 2>/dev/null || true
gosu agentuser git config --global user.email "$GIT_EMAIL" 2>/dev/null || true

# --- Drop privileges and exec -------------------------------------
if [ $# -eq 0 ]; then
    # No command → fall through to interactive shell (debug mode)
    exec gosu agentuser /bin/bash
fi

exec gosu agentuser "$@"
