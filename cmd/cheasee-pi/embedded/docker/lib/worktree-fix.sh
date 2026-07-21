#!/bin/bash
#
# worktree-fix.sh — shared library for git worktree path rewriting
#
# Provides unbreak_worktrees() which idempotently:
#   1. Rewrites absolute host paths in .git files to relative paths
#   2. Rewrites reciprocal gitdir files in .bare/worktrees/<id>/gitdir
#   3. Recovers pruned worktree registrations (missing gitdir files)
#   4. Locks all worktrees to prevent future pruning
#
# Designed to be sourced by entrypoint.sh and also by test suites.

# ------------------------------------------------------------------
# unbreak_worktrees
#
# Discovers the bare git repository and rewrites all worktree linking
# paths from absolute (host) to relative so that git works regardless
# of the container mount point. Also locks all worktrees as a
# defense-in-depth measure against git worktree prune.
#
# Accepts an optional workspace base path (default /workspaces).
# This parameter is used by the test suite to run against temp directories.
#
# Returns 0 always — failures inside are non-fatal and logged.
# ------------------------------------------------------------------
unbreak_worktrees() {
    local WORKSPACE_BASE="${1:-/workspaces}"
    local BARE_DIR=""
    local MAIN_GITDIR=""

    # ---- Step 0: Discover bare repository location ----

    # Try to discover via main worktree's .git file.
    # The gitdir path may be absolute (e.g. /workspaces/.bare/worktrees/main) or
    # relative (e.g. ../.bare/worktrees/main). We only use the absolute path for
    # bare dir discovery because relative paths need to be resolved against the
    # worktree's location, not the current working directory.
    if [ -f "$WORKSPACE_BASE/main/.git" ]; then
        local first_line
        read -r first_line < "$WORKSPACE_BASE/main/.git" 2>/dev/null || true
        if [[ "$first_line" =~ ^gitdir:\ (.*) ]]; then
            MAIN_GITDIR="${BASH_REMATCH[1]}"
            # Only use absolute paths for bare dir extraction
            if [[ "${MAIN_GITDIR:0:1}" == "/" ]] && [[ "$MAIN_GITDIR" == */.bare/* ]]; then
                local extracted="${MAIN_GITDIR%/.bare/*}/.bare"
                if [ -d "$extracted" ]; then
                    BARE_DIR="$extracted"
                fi
            fi
        fi
    fi

    # Fallback: check WORKSPACE_BASE/.bare (works for container mounts and test fixtures)
    if [ -z "$BARE_DIR" ]; then
        local candidate="$WORKSPACE_BASE/.bare"
        if [ -d "$candidate" ]; then
            BARE_DIR="$candidate"
        fi
    fi

    if [ -z "$BARE_DIR" ] || [ ! -d "$BARE_DIR" ]; then
        echo "Warning: Could not find .bare directory in $WORKSPACE_BASE — skipping worktree fix" >&2
        return 0
    fi

    echo "Worktree fix: BARE_DIR=$BARE_DIR"

    # ---- Step 1: Fix worktree .git files ----
    # Rewrite absolute host paths that don't exist inside container to relative paths.
    # E.g. gitdir: /home/user/git/.bare/worktrees/feature-x  ->  gitdir: ../.bare/worktrees/feature-x
    find "$WORKSPACE_BASE" -maxdepth 3 -name '.git' -type f 2>/dev/null | while read -r f; do
        # read returns non-zero on EOF without newline; we use || : to handle both cases
        read -r line < "$f" 2>/dev/null || :
        [[ "$line" =~ ^gitdir:\ (.*) ]] || continue
        local path="${BASH_REMATCH[1]}"
        [[ "${path:0:1}" == "/" ]] || continue          # skip already-relative
        [[ -d "$path" ]] && continue                     # skip already-valid (path exists in container)
        local suffix="${path#*/.bare}"
        echo "gitdir: ../.bare$suffix" > "$f"
        echo "  Fixed .git: $f  ->  ../.bare$suffix"
    done

    # ---- Step 2: Fix reciprocal gitdir files ----
    # .bare/worktrees/<id>/gitdir contains the path back to the worktree's .git file.
    # Rewrite absolute to relative: /home/user/git/main/.git  ->  ../../../main/.git
    # The path goes up 3 levels: worktrees/<id>/ -> worktrees/ -> .bare/ -> workspace root, then into <id>/.git
    find "$BARE_DIR/worktrees" -name 'gitdir' -type f 2>/dev/null | while read -r f; do
        # read returns non-zero on EOF without newline; we use || : to handle both cases
        read -r content < "$f" 2>/dev/null || :
        [[ "${content:0:1}" == "/" ]] || continue        # skip already-relative
        [[ -f "$content" ]] && continue                   # skip already-valid
        local worktree_id
        worktree_id=$(basename "$(dirname "$f")")
        echo "../../../$worktree_id/.git" > "$f"
        echo "  Fixed gitdir: $f  ->  ../../../$worktree_id/.git"
    done

    # ---- Step 3: Recover pruned worktree registrations ----
    # If a worktree's .git file has a relative path (was fixed in step 1 or already relative)
    # but the corresponding .bare/worktrees/<id>/gitdir is missing (deleted by prune), recreate it.
    find "$WORKSPACE_BASE" -maxdepth 3 -name '.git' -type f 2>/dev/null | while read -r f; do
        # read returns non-zero on EOF without newline; we use || : to handle both cases
        read -r line < "$f" 2>/dev/null || :
        [[ "$line" =~ ^gitdir:\ (.*) ]] || continue
        local path="${BASH_REMATCH[1]}"
        [[ "$path" == ..* ]] || continue                 # only handle relative paths
        local worktree_dir
        worktree_dir=$(dirname "$f")
        local worktree_name
        worktree_name=$(basename "$worktree_dir")
        local gitdir_path="$BARE_DIR/worktrees/$worktree_name/gitdir"
        [[ -f "$gitdir_path" ]] && continue              # already has registration
        mkdir -p "$(dirname "$gitdir_path")" 2>/dev/null || continue
        echo "../../../$worktree_name/.git" > "$gitdir_path"
        echo "  Recovered: $gitdir_path  ->  ../../../$worktree_name/.git"
    done

    # ---- Step 4: Lock all worktrees ----
    # Prevent git worktree prune (and git gc which calls it) from deleting
    # worktree registrations. The locked file is a simple presence check by git.
    if [ -d "$BARE_DIR/worktrees" ]; then
        for wt_dir in "$BARE_DIR/worktrees"/*/; do
            [ -d "$wt_dir" ] || continue
            local lock_file="$wt_dir/locked"
            [[ -f "$lock_file" ]] && continue            # already locked
            echo "Locked by entrypoint.sh — shared filesystem container worktree" > "$lock_file"
            echo "  Locked: $lock_file"
        done
    fi

    echo "Worktree fix complete"
    return 0
}
