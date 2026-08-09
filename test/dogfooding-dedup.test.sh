#!/usr/bin/env bash
# test/dogfooding-dedup.test.sh
#
# Container-level acceptance test for issue #1497: running cheasee-pi inside
# the cheasee-pi repo (dogfooding) must load each tracked skill/extension/
# prompt exactly once. The entrypoint re-points the global ~/.pi/agent
# resource symlinks at the live mounted repo when the structural marker
# matches; pi's realpath-keyed mergePaths dedup then collapses the global +
# project loads into one.
#
# Fixture: test/fixtures/dogfooding-marker/ — an extension that appends one
# line to $MARKER_LOG at load time. The script injects it into the mounted
# repo's .pi/extensions/marker-dedup/ and counts lines:
#   - fixed run (repo detected): global symlink + project paths resolve to one
#     realpath → exactly 1 line
#   - control (detection disabled via go.mod module rewrite): the marker is
#     reachable via two distinct realpaths (repo + /opt mount) → 2 lines,
#     proving the fixture detects duplication
#
# Requires a running docker daemon and node. Builds the test image only if
# absent (warm cache ~2-5 min, cold build 15-30 min).
#
# Run: bash test/dogfooding-dedup.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="cheasee-pi:test-1497"
DOCKER_CONTEXT="$ROOT/cmd/cheasee-pi/embedded/docker"
MARKER_SRC="$ROOT/test/fixtures/dogfooding-marker/index.ts"
MARKER_REPO_DIR=".pi/extensions/marker-dedup"
OUT_DIR="$(mktemp -d)"
MARKER_LOG_HOST="$OUT_DIR/marker.log"
AGENT_STATE="$OUT_DIR/agent"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

UNRELATED=""
cleanup() {
    rm -rf "$MARKER_REPO_DIR"
    [ -n "$UNRELATED" ] && rm -rf "$UNRELATED"
    git checkout -- .pi/settings.json go.mod 2>/dev/null || true
    rm -rf "$OUT_DIR"
}
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
    echo "SKIP: docker daemon not available — container suite requires a running daemon"
    exit 0
fi

# ------------------------------------------------------------------
echo "== Phase 0: image + marker setup =="
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Building test image $IMAGE (cold build 15-30 min; cached on reruns)…"
    docker build -t "$IMAGE" "$DOCKER_CONTEXT"
fi
echo "pi version in image: $(docker run --rm --entrypoint pi "$IMAGE" --version 2>/dev/null || echo unknown)"

# inject_marker <settings-extension-entry>... — copies the marker fixture into
# the repo's .pi/extensions/marker-dedup/ and appends the given entries to the
# committed .pi/settings.json extensions array (restored by cleanup).
inject_marker() {
    mkdir -p "$MARKER_REPO_DIR"
    cp "$MARKER_SRC" "$MARKER_REPO_DIR/index.ts"
    node -e '
        const fs = require("fs");
        const p = ".pi/settings.json";
        const s = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const e of process.argv.slice(1)) {
            if (!s.extensions.includes(e)) s.extensions.push(e);
        }
        fs.writeFileSync(p, JSON.stringify(s, null, "\t") + "\n");
    ' "$@"
}

# run_pi <outfile> [extra docker args...] — runs a fresh container with the
# repo mounted at /workspaces/main AND /opt/cheasee-pi (baked copy shadowed so
# the marker exists on both load paths). pi's exit code is tolerated: without
# an API key the model call fails after startup, but extension loading (the
# marker) happens before that and is what the test counts.
run_pi() {
    local outfile="$1"
    shift
    : > "$MARKER_LOG_HOST"
    set +e
    timeout 300 docker run --rm \
        -e MARKER_LOG=/tmp/marker.log \
        -e PI_TELEMETRY=0 \
        -v "$ROOT:/workspaces/main" \
        -v "$ROOT:/opt/cheasee-pi" \
        -v "$MARKER_LOG_HOST:/tmp/marker.log" \
        "$@" \
        "$IMAGE" pi -a -p "hello" >"$outfile" 2>&1
    local rc=$?
    set -e
    echo "    (pi exit=$rc)"
}

# ------------------------------------------------------------------
echo "== Phase 1: fixed run — cheasee-pi repo detected, resources deduped =="
inject_marker ".pi/extensions/marker-dedup"
run_pi "$OUT_DIR/pi-fixed.log"
lines=$(wc -l < "$MARKER_LOG_HOST")
if [ "$lines" -eq 1 ]; then
    pass "marker loaded exactly once in the fixed scenario (got $lines line)"
else
    fail "marker loaded $lines times in the fixed scenario (expected exactly 1)"
fi
if grep -q 'conflicts with' "$OUT_DIR/pi-fixed.log" || grep -qi 'collision' "$OUT_DIR/pi-fixed.log"; then
    fail "conflict/collision diagnostics present in fixed run — see $OUT_DIR/pi-fixed.log"
else
    pass "no extension-conflict or prompt/theme-collision diagnostics in fixed run"
fi
# The global symlink for the injected marker must exist and target the live repo
link_target="$(docker run --rm \
    -v "$ROOT:/workspaces/main" \
    -v "$ROOT:/opt/cheasee-pi" \
    "$IMAGE" readlink /home/agentuser/.pi/agent/extensions/marker-dedup 2>/dev/null || true)"
if [ "$link_target" = "/workspaces/main/.pi/extensions/marker-dedup" ]; then
    pass "global extension symlink re-pointed at live repo ($link_target)"
else
    fail "global extension symlink not re-pointed (got '$link_target')"
fi

# ------------------------------------------------------------------
echo "== Phase 2: duplication-sensitive control — detection disabled =="
git checkout -- .pi/settings.json
inject_marker ".pi/extensions/marker-dedup" "/opt/cheasee-pi/.pi/extensions/marker-dedup"
sed -i 's|^module .*|module example.com/nope|' go.mod
run_pi "$OUT_DIR/pi-control.log"
sed -i 's|^module .*|module github.com/SchneiderDaniel/cheasee-pi|' go.mod
lines=$(wc -l < "$MARKER_LOG_HOST")
if [ "$lines" -eq 2 ]; then
    pass "control run loaded the marker twice (got $lines lines) — fixture detects duplication"
else
    fail "control run expected 2 loads (distinct realpaths), got $lines"
fi

# ------------------------------------------------------------------
echo "== Phase 3: idempotence across restarts (persisted agent home) =="
git checkout -- .pi/settings.json
inject_marker ".pi/extensions/marker-dedup"
# Seed a persisted agent home from the image's baked state so both runs start
# from the same global symlinks and the second run must be a no-op re-point.
mkdir -p "$AGENT_STATE"
docker run --rm --entrypoint /bin/bash "$IMAGE" -c 'tar -C /home/agentuser -cf - .' | tar -C "$AGENT_STATE" -xf -
run_pi "$OUT_DIR/pi-idem1.log" -v "$AGENT_STATE:/home/agentuser"
c1=$(wc -l < "$MARKER_LOG_HOST")
run_pi "$OUT_DIR/pi-idem2.log" -v "$AGENT_STATE:/home/agentuser"
c2=$(wc -l < "$MARKER_LOG_HOST")
if [ "$c1" -eq 1 ] && [ "$c2" -eq 2 ]; then
    pass "exactly one load per restart (run1=$c1, run2=$c2 total lines)"
else
    fail "load counts across restarts: run1=$c1, run2=$c2 (expected 1 then 2)"
fi
l1="$(docker run --rm -v "$ROOT:/workspaces/main" -v "$ROOT:/opt/cheasee-pi" -v "$AGENT_STATE:/home/agentuser" "$IMAGE" readlink /home/agentuser/.pi/agent/extensions/marker-dedup 2>/dev/null || true)"
l2="$(docker run --rm -v "$ROOT:/workspaces/main" -v "$ROOT:/opt/cheasee-pi" -v "$AGENT_STATE:/home/agentuser" "$IMAGE" readlink /home/agentuser/.pi/agent/extensions/marker-dedup 2>/dev/null || true)"
if [ -n "$l1" ] && [ "$l1" = "$l2" ]; then
    pass "readlink unchanged across restarts ($l1)"
else
    fail "readlink changed across restarts ('$l1' → '$l2')"
fi
if [[ "$l1" != *"/.pi/agent/"* ]]; then
    pass "no nested symlink (target does not contain another ~/.pi/agent path)"
else
    fail "nested symlink detected: $l1"
fi

# live-edit user journey: edit the marker's message in the mounted repo,
# restart the container → the new message must appear (edits load live, no
# stale /opt copy).
sed -i 's/marker:loaded/marker:loaded-v2/' "$MARKER_REPO_DIR/index.ts"
run_pi "$OUT_DIR/pi-liveedit.log" -v "$AGENT_STATE:/home/agentuser"
if grep -q 'marker:loaded-v2' "$MARKER_LOG_HOST"; then
    pass "edited marker message appears after restart (live repo edits load)"
else
    fail "edited marker message did not appear after restart"
fi

# ------------------------------------------------------------------
echo "== Phase 4: non-cheasee-pi repo — global availability unchanged =="
git checkout -- .pi/settings.json go.mod
rm -rf "$MARKER_REPO_DIR"
UNRELATED="$(mktemp -d)"
(
    cd "$UNRELATED"
    git init -q
    echo "module example.com/unrelated" > go.mod
    mkdir -p src
    echo "package main" > src/main.go
    git add -A
    git -c user.email=test@example.com -c user.name=Test commit -qm init
)
set +e
timeout 300 docker run --rm \
    -e PI_TELEMETRY=0 \
    -v "$UNRELATED:/workspaces/main" \
    "$IMAGE" pi -a -p "hello" >"$OUT_DIR/pi-unrelated.log" 2>&1
rc=$?
set -e
echo "    (pi exit=$rc)"
# Global symlinks must be untouched (still → /opt/cheasee-pi)
baked_target="$(docker run --rm --entrypoint /bin/bash "$IMAGE" -c 'readlink /home/agentuser/.pi/agent/skills/ponytail' 2>/dev/null || true)"
case "$baked_target" in
    /opt/cheasee-pi/*)
        pass "global symlinks unchanged (→ /opt/cheasee-pi) for non-cheasee-pi repo ($baked_target)"
        ;;
    *)
        fail "global symlink altered for non-cheasee-pi repo (got '$baked_target')"
        ;;
esac
if grep -q 'conflicts with' "$OUT_DIR/pi-unrelated.log"; then
    fail "extension conflicts in unrelated repo session"
else
    pass "no extension conflicts in unrelated repo session (global resources load once)"
fi

echo
if [ "$FAIL" -eq 0 ]; then
    echo "dogfooding-dedup: all $PASS checks passed"
    exit 0
else
    echo "dogfooding-dedup: $FAIL checks FAILED ($PASS passed) — logs in $OUT_DIR"
    exit 1
fi
