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

# --- Pre-install Python venvs for web tools -------------------------
# Copy pre-built venvs from /opt/venvs/ to .pi/ if missing (saves first-call
# latency in web_search / web_crawl).
for v in web-search-venv scrapling-venv; do
    [ -d "/opt/venvs/$v" ] && [ ! -d "/workspaces/main/.pi/$v" ] || continue
    echo "Pre-installing $v…"
    mkdir -p /workspaces/main/.pi
    cp -a "/opt/venvs/$v" "/workspaces/main/.pi/$v"
done
# Symlink Playwright browser cache so agentuser finds Chromium
if [ -d /opt/playwright-browsers ]; then
    mkdir -p /home/agentuser/.cache
    ln -sf /opt/playwright-browsers /home/agentuser/.cache/ms-playwright 2>/dev/null || true
fi
# Chromium presence guard — web_crawl stealth tier needs patchright's build here.
# Loud warning (not fatal) at container start; the Dockerfile build itself fails
# fatally when the download failed (layer 5e), so this only fires on stale images.
if ! ls /opt/playwright-browsers/chromium-*/chrome-linux64/chrome >/dev/null 2>&1; then
    echo "WARNING: Chromium missing in /opt/playwright-browsers — web_crawl stealth tier will fail."
    echo "         Fix: /opt/venvs/scrapling-venv/bin/python -m patchright install chromium"
fi

# --- Re-point global pi resources at the live repo (dogfooding) ------
# When the mounted repo IS cheasee-pi, the baked /opt/cheasee-pi copy and the
# repo-local tree would load identical resources twice (pi merges global +
# project settings arrays and dedupes by resolved realpath only). Re-pointing
# the global ~/.pi/agent symlinks at the live repo makes both resolve to one
# canonical path → pi loads each resource exactly once, and edits made in the
# mounted repo are live (no stale /opt copy).
#
# Marker contract (documented in Dockerfile Layer 6b): the repo is considered
# cheasee-pi iff /workspaces/main/cmd/cheasee-pi/embedded/docker/ exists AND
# go.mod declares module github.com/SchneiderDaniel/cheasee-pi. Structural by
# design — NOT content-based ("has .pi/skills" would false-positive on any pi
# user's repo). Upstream module only: renamed-module forks don't match and
# keep the baked /opt copy.
is_cheasee_pi_repo() {
    [ -d /workspaces/main/cmd/cheasee-pi/embedded/docker ] || return 1
    MODULE="$(grep -m1 '^module ' /workspaces/main/go.mod 2>/dev/null)" || return 1
    [ "$MODULE" = "module github.com/SchneiderDaniel/cheasee-pi" ] || return 1
    return 0
}

# link_owned <link> <target> — create or re-point <link> at <target>, owned by
# agentuser. Owner of the low-level symlink semantics shared by re_point /
# re_point_file / the custom/ link: re-links only under a [ -L ] guard,
# no-ops when readlink already equals the target (idempotent), creates
# missing links, leaves a real file/dir at the link name untouched (Stow
# conflict refusal). Load-bearing: -n (a symlink-to-dir destination would be
# written through) and chown -h/lchown (bare chown re-owns the live repo file).
link_owned() {
    local link="$1" target="$2"
    if [ -L "$link" ]; then
        [ "$(readlink "$link")" = "$target" ] && return 0
        ln -sfn "$target" "$link"
        chown -h agentuser:agentuser "$link" 2>/dev/null || true
    elif [ ! -e "$link" ]; then
        ln -s "$target" "$link"
        chown -h agentuser:agentuser "$link" 2>/dev/null || true
    fi
}

# re_point <agent_subdir> <repo_dir> — re-point the global resource symlinks
# at the live repo's entries. Policy only: dirs, dotfile skip, missing-target
# guards — the link semantics live in link_owned.
re_point() {
    local agent_subdir="$1" repo_dir="$2"
    local agent_dir="/home/agentuser/.pi/agent/$agent_subdir"
    [ -d "$agent_dir" ] || return 0
    [ -d "$repo_dir" ] || return 0
    local d name
    for d in "$repo_dir"/*; do
        [ -e "$d" ] || continue
        name="$(basename "$d")"
        [[ "$name" == .* ]] && continue
        link_owned "$agent_dir/$name" "$d"
    done
}

# re_point_file — thin link_owned wrapper for single-file links
# (missing repo file → baked /opt link stays, no dangling links).
re_point_file() {
    local agent_file="$1" repo_file="$2"
    [ -e "$repo_file" ] || return 0
    link_owned "$agent_file" "$repo_file"
}

if is_cheasee_pi_repo; then
    echo "Detected cheasee-pi repo at /workspaces/main — re-pointing global pi resources at the live repo"
    re_point skills /workspaces/main/.pi/skills
    re_point extensions /workspaces/main/.pi/extensions
    re_point prompts /workspaces/main/.pi/prompts
    re_point themes /workspaces/main/.pi/themes
    re_point_file /home/agentuser/.pi/agent/APPEND_SYSTEM.md /workspaces/main/APPEND_SYSTEM.md
    # Whole-dir custom/ link (gitignored, absent on most clones)
    if [ -d /workspaces/main/custom ]; then
        link_owned /home/agentuser/.pi/agent/custom /workspaces/main/custom
    fi
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

# The sibling bare repo is a separate mount — fix its ownership the same way
# (worktree-fix + git gc paths inside it run as agentuser).
BARE_OWNER=$(stat -c '%u:%g' /workspaces/.bare 2>/dev/null || echo "")
if [ -n "$BARE_OWNER" ] && [ "$BARE_OWNER" != "$AGENT_UID:$AGENT_GID" ]; then
    echo "Fixing /workspaces/.bare ownership to agentuser ($AGENT_UID:$AGENT_GID)..."
    chown -R agentuser:agentuser /workspaces/.bare || echo "Warning: chown /workspaces/.bare failed (non-fatal)"
fi

# The parent /workspaces dir is container-local (not a bind mount) and stays
# root-owned unless fixed. The supervisor creates worktrees as SIBLINGS of
# main/ and .bare/ (git worktree add writes directly under /workspaces), so
# agentuser must be able to mkdir there. Non-recursive on purpose — recursing
# would descend into the /workspaces/main and /workspaces/.bare mounts, which
# are handled separately above.
WORKSPACE_PARENT_OWNER=$(stat -c '%u:%g' /workspaces 2>/dev/null || echo "")
if [ -n "$WORKSPACE_PARENT_OWNER" ] && [ "$WORKSPACE_PARENT_OWNER" != "$AGENT_UID:$AGENT_GID" ]; then
    echo "Fixing /workspaces ownership to agentuser ($AGENT_UID:$AGENT_GID)..."
    chown agentuser:agentuser /workspaces || echo "Warning: chown /workspaces failed (non-fatal)"
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

# cheasee-pi auth persists the GitHub token in auth.json (bind-mounted) and
# that file is the single source of truth for the container's GitHub
# credential: init/--reauth mint it with the scopes the supervisor needs
# (repo, read:org, project). The bind-mounted ~/.config/gh may hold an older
# token minted before the project scope existed, so import auth.json's token
# into gh whenever gh's current token differs — not just when gh has none.
# gating on gh auth status would keep the stale token forever.
if [ -f /home/agentuser/.config/cheasee-pi/auth.json ]; then
    token=$(jq -r '.github_token // empty' /home/agentuser/.config/cheasee-pi/auth.json 2>/dev/null || true)
    current=$(gosu agentuser gh auth token 2>/dev/null || true)
    if [ -n "$token" ] && [ "$token" != "$current" ]; then
        echo "$token" | gosu agentuser gh auth login --with-token 2>/dev/null || true
    fi
fi
# Mark the bare repo safe for container git ops — a host-owned .bare mount
# would otherwise trip "detected dubious ownership" (CVE-2022-24765
# mitigation) on every git call inside the container.
gosu agentuser git config --global --add safe.directory /workspaces/.bare 2>/dev/null || true

# --- Install custom skill repositories (pi git packages) ----------
# init records canonical skill repo specs in /workspaces/main/cheasee-settings.json
# (skillRepos); pi runs only inside the container, so the entrypoint is the
# single translator: `pi install -l -a` per recorded repo — project-local
# (clones land in the bind-mounted .pi/git/ and survive container recreation)
# with a one-run trust override (-a) because the workspace is untrusted until
# pi's own interactive trust prompt is answered. pi owns the settings packages
# array — this section never hand-writes it. Per-repo failures are
# tolerated (a bad/private/offline repo must not abort container start);
# GitHub repos are covered by the gh credential helper, and GIT_TERMINAL_PROMPT=0
# stops non-GitHub SSH-only repos from hanging on credential prompts.
install_skill_repos() {
    local settings="/workspaces/main/cheasee-settings.json"
    [ -f "$settings" ] || return 0
    local specs
    specs=$(jq -r '.skillRepos // empty | .[]' "$settings" 2>/dev/null) || return 0
    [ -n "$specs" ] || return 0
    if [ "${PI_OFFLINE:-}" = "1" ] || [ "${PI_OFFLINE:-}" = "true" ] || [ "${PI_OFFLINE:-}" = "yes" ]; then
        echo "Warning: PI_OFFLINE is set — skill repos will not be installed (pi silently skips missing packages offline)"
    fi
    local spec
    while IFS= read -r spec; do
        [ -n "$spec" ] || continue
        echo "Installing skill repo: $spec"
        if ! GIT_TERMINAL_PROMPT=0 gosu agentuser pi install -l -a "$spec" 2>&1; then
            echo "Warning: skill repo install failed: $spec (non-fatal — check the spec or network access)"
        fi
    done <<< "$specs"
}
install_skill_repos

# --- Install workspace npm dependencies if missing -------------------
# The workspace is a bind-mount from the host; node_modules is local to the
# container and must be installed at runtime. Skip if already present so
# subsequent container starts are fast.
# Guard on npm's install marker (.package-lock.json), NOT on the node_modules
# dir: a stale dir containing only .cache/jiti (created by pi's extension
# loader) would otherwise skip the install forever and every extension that
# imports a third-party package fails to load.
if [ ! -f /workspaces/main/node_modules/.package-lock.json ]; then
    echo "Installing workspace npm dependencies…"
    gosu agentuser bash -c 'cd /workspaces/main && npm install --no-audit --no-fund' \
        || echo "Warning: npm install failed (non-fatal — pi may still work depending on which extensions are loaded)"
fi

# --- Signal readiness ----------------------------------------------
# The compose healthcheck (test -f /tmp/.cheasee-pi-ready) only passes after
# every setup step above — including the workspace npm install — so
# `cheasee-pi start` (which waits for healthy before execing pi) never races
# first-run dependency installation.
touch /tmp/.cheasee-pi-ready

# --- Drop privileges and exec -------------------------------------
if [ $# -eq 0 ]; then
    # No command → fall through to interactive shell (debug mode)
    exec gosu agentuser /bin/bash
fi

exec gosu agentuser "$@"
