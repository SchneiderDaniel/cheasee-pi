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
#   HOST_UID  – host user   ID to map agentuser to
#   HOST_GID  – host group  ID to map agentuser group to
# ------------------------------------------------------------------

HOST_UID="${HOST_UID:-}"
HOST_GID="${HOST_GID:-}"

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

# --- Update file ownership ----------------------------------------
# Ensure the workspace and home directory are owned by the (possibly
# remapped) user so bind-mounted volumes are writable.
chown -R agentuser:agentuser /workspaces/main /home/agentuser 2>/dev/null || true

# --- Drop privileges and exec -------------------------------------
if [ $# -eq 0 ]; then
    # No command → fall through to interactive shell (debug mode)
    exec gosu agentuser /bin/bash
fi

exec gosu agentuser "$@"
