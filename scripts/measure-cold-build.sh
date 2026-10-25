#!/usr/bin/env bash
# scripts/measure-cold-build.sh
#
# Cold-build cost measurement for issue #2053 (BuildKit cache mounts, the
# separate `scrapling` stage, digest-pinned base images).
#
# A cache-pruned Docker build needs a daemon; this script does not. It replays
# the download half of cmd/cheasee-pi/embedded/docker/Dockerfile — the same apt,
# pip, npm and curl steps, in the same order, against the same pinned base
# image — and counts every byte that leaves the host through a local proxy.
# Each step is timed. The result is what a cold build transfers and how long
# the transfer plus interpreter work takes, measured, not derived.
#
# What it does NOT cover (a Docker host is required for these):
#   * layer commit/snapshot time and the base-image pull path of `docker build`
#     (`docker buildx prune -af` + `time cheasee-pi build`, see
#     docs/development.md §Measuring image build cost);
#   * `dpkg` unpack+configure, which needs root.
# The network I/O the issue is about — ~99% of a cold build's cost — is covered.
#
# Requirements: Debian/Ubuntu host with python3, npm, curl, jq, tar; network
# access; ~2 GB free in $TMPDIR (each step's downloads are deleted after they
# are counted). Run manually, never in CI.
#
# Usage: bash scripts/measure-cold-build.sh
#        Output is a markdown table — paste it into the issue/§Recorded numbers.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_DIR="$REPO_ROOT/cmd/cheasee-pi/embedded/docker"
BASE_IMAGE="$(sed -n 's/^ARG BASE_IMAGE=//p' "$DOCKER_DIR/Dockerfile")"
WORK="$(mktemp -d)"
PROXY_LOG="$WORK/proxy.log"
START_NS=""
cleanup() { [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

die() { echo "measure-cold-build: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
for t in python3 npm curl jq tar git apt-get; do need "$t"; done

# ---------------------------------------------------------------- byte counter
# A relay proxy that counts bytes in both directions. Everything the build
# fetches honours http(s)_proxy, so one counter covers apt, pip, npm, git and
# curl without per-tool special cases. CONNECT tunnels are counted as raw
# relayed bytes; that is the wire cost of the transfer.
cat >"$WORK/proxy.py" <<'PY'
import json, socket, sys, threading

PORT_FILE, LOG_FILE = sys.argv[1], sys.argv[2]
lock = threading.Lock()


def record(host, up, down):
    with lock, open(LOG_FILE, "a") as fh:
        fh.write(json.dumps({"host": host, "up": up, "down": down}) + "\n")


def pump(src, dst, counter, idx):
    try:
        while True:
            chunk = src.recv(65536)
            if not chunk:
                break
            counter[idx] += len(chunk)
            dst.sendall(chunk)
    except OSError:
        pass
    finally:
        for sock in (src, dst):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def relay(client, upstream, head, host):
    counts = [0, 0]  # [client->upstream, upstream->client]
    if head:
        counts[0] += len(head)
        try:
            upstream.sendall(head)
        except OSError:
            pass
    threads = [
        threading.Thread(target=pump, args=(client, upstream, counts, 0), daemon=True),
        threading.Thread(target=pump, args=(upstream, client, counts, 1), daemon=True),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    record(host, counts[0], counts[1])
    client.close()
    upstream.close()


def read_head(conn):
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = conn.recv(65536)
        if not chunk:
            return None, b""
        head += chunk
        if len(head) > 65536:
            break
    head, _, rest = head.partition(b"\r\n\r\n")
    return head, rest


def handle(conn):
    try:
        head, rest = read_head(conn)
        if head is None:
            conn.close()
            return
        request_line = head.split(b"\r\n", 1)[0].decode("latin1")
        method, target = request_line.split(" ")[:2]
        if method.upper() == "CONNECT":
            host, _, port = target.partition(":")
            upstream = socket.create_connection((host, int(port or 443)), timeout=60)
            conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            payload = rest
        else:  # absolute-form plain HTTP through a proxy: forward origin-form
            without_scheme = target.split("://", 1)[-1]
            host, _, port = without_scheme.split("/", 1)[0].partition(":")
            upstream = socket.create_connection((host, int(port or 80)), timeout=60)
            request_head, _, tail = head.partition(b"\r\n")
            path = "/" + without_scheme.split("/", 1)[1] if "/" in without_scheme else "/"
            payload = f"{method} {path} HTTP/1.1".encode() + b"\r\n" + tail + b"\r\n\r\n" + rest
        relay(conn, upstream, payload, host)
    except OSError:
        try:
            conn.close()
        except OSError:
            pass


server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen(64)
open(PORT_FILE, "w").write(str(server.getsockname()[1]))
while True:
    client, _ = server.accept()
    threading.Thread(target=handle, args=(client,), daemon=True).start()
PY

python3 "$WORK/proxy.py" "$WORK/port" "$PROXY_LOG" &
PROXY_PID=$!
for _ in $(seq 1 100); do [ -s "$WORK/port" ] && break; sleep 0.05; done
PORT="$(cat "$WORK/port" 2>/dev/null)"
[ -n "$PORT" ] || die "counting proxy did not start"
PROXY="http://127.0.0.1:$PORT"
export http_proxy="$PROXY" https_proxy="$PROXY" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY"
export no_proxy="127.0.0.1,localhost" NO_PROXY="127.0.0.1,localhost"

transferred() { if [ -s "$PROXY_LOG" ]; then jq -s 'map(.up + .down) | add' "$PROXY_LOG"; else echo 0; fi; }
group() { python3 -c 'import sys; print(f"{int(sys.argv[1]):,}")' "$1"; }
secs() { awk -v ns="$1" 'BEGIN { printf "%.1f", ns / 1000000000 }'; }

TOTAL_BYTES=0
TOTAL_NS=0
declare -A STAGE_BYTES STAGE_NS

# measure <stage> <step name> <command...> — runs a step, prints its row, and
# folds its cost into the stage and grand totals.
measure() {
  local stage="$1" name="$2"
  shift 2
  local before after t0 t1 row_bytes row_ns
  before="$(transferred)"
  t0="$(date +%s%N)"
  : >"$WORK/step.log"
  if ! "$@" >>"$WORK/step.log" 2>&1; then
    tail -20 "$WORK/step.log" >&2
    die "step '$name' failed — refusing to record a partial total"
  fi
  t1="$(date +%s%N)"
  after="$(transferred)"
  row_bytes=$((after - before))
  row_ns=$((t1 - t0))
  TOTAL_BYTES=$((TOTAL_BYTES + row_bytes))
  TOTAL_NS=$((TOTAL_NS + row_ns))
  STAGE_BYTES[$stage]=$(( ${STAGE_BYTES[$stage]:-0} + row_bytes ))
  STAGE_NS[$stage]=$(( ${STAGE_NS[$stage]:-0} + row_ns ))
  printf '| %s | %s | %s B | %s s |\n' "$stage" "$name" "$(group "$row_bytes")" "$(secs "$row_ns")"
}

subtotal() {
  local stage="$1" label="$2"
  printf '| **stage** | **%s subtotal** | **%s B** | **%s s** |\n' \
    "$label" "$(group "${STAGE_BYTES[$stage]:-0}")" "$(secs "${STAGE_NS[$stage]:-0}")"
}

# ------------------------------------------------------------------- apt setup
# The pinned base image supplies the apt seed (what is already installed) and
# its own sources.list, so a step measures what it would still fetch inside the
# image rather than a from-scratch install.
BASE_TAG="${BASE_IMAGE%%@*}"
BASE_REPO="${BASE_TAG%%:*}"
BASE_DIGEST="${BASE_IMAGE##*@}"
[ -n "$BASE_DIGEST" ] || die "Dockerfile ARG BASE_IMAGE carries no @sha256 digest"

registry_auth() {
  curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/$BASE_REPO:pull" |
    jq -r .token
}

fetch_base_image() {
  local token manifest layer
  token="$(registry_auth)"
  manifest="$(curl -fsS -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json' \
    "https://registry-1.docker.io/v2/library/$BASE_REPO/manifests/$BASE_DIGEST" |
    jq -r '.manifests[] | select(.platform.architecture == "amd64" and .platform.os == "linux") | .digest' | head -1)"
  [ -n "$manifest" ] || die "cannot resolve the amd64 manifest of $BASE_IMAGE"
  layer="$(curl -fsS -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json' \
    "https://registry-1.docker.io/v2/library/$BASE_REPO/manifests/$manifest" | jq -r '.layers[0].digest')"
  curl -fsSL -H "Authorization: Bearer $token" \
    "https://registry-1.docker.io/v2/library/$BASE_REPO/blobs/$layer" -o "$WORK/base.tar.gz"
  mkdir -p "$WORK/base"
  tar -xzf "$WORK/base.tar.gz" -C "$WORK/base" --wildcards \
    'var/lib/dpkg/status' 'etc/apt/*' 'usr/share/keyrings/*' || true
  rm -f "$WORK/base.tar.gz"
  [ -s "$WORK/base/var/lib/dpkg/status" ] || die "base image layer has no dpkg status"
  local srcdir="$WORK/base/etc/apt/sources.list.d"
  mkdir -p "$srcdir"
  ls "$srcdir"/*.sources >/dev/null 2>&1 || cp /etc/apt/sources.list.d/debian.sources "$srcdir/"
  # point the base image's own debian.sources at the keyrings we just unpacked
  sed -i "s|/usr/share/keyrings|$WORK/base/usr/share/keyrings|g" "$srcdir"/*.sources
}

# apt_get <sourceparts dir> <apt-get subcommand...>
apt_get() {
  local parts="$1"
  shift
  mkdir -p "$WORK/lists/partial" "$WORK/cache/archives"
  apt-get \
    -o Debug::NoLocking=1 \
    -o Dir::State::status="$WORK/base/var/lib/dpkg/status" \
    -o Dir::State::lists="$WORK/lists" \
    -o Dir::Cache="$WORK/cache" \
    -o Dir::Etc::sourcelist=/dev/null \
    -o Dir::Etc::sourceparts="$parts" \
    -o Dir::Etc::parts="$WORK/aptconf" \
    -o Acquire::http::Proxy="$PROXY" -o Acquire::https::Proxy="$PROXY" \
    -o Acquire::Retries=3 \
    -y "$@"
}

# sources <step> <extra source line...> — a source dir for one step
sources() {
  local dir="$WORK/src-$1"
  shift
  rm -rf "$dir"
  mkdir -p "$dir"
  cp "$WORK/base/etc/apt/sources.list.d/"* "$dir/"
  local line
  for line in "$@"; do printf '%s\n' "$line" >"$dir/extra.list"; done
  printf '%s' "$dir"
}

# `Trusted: yes` on the extra repos: this measures the bytes apt would fetch,
# not signature verification (the build does that, with real keyrings).
NODESOURCE='deb [arch=amd64 trusted=yes] https://deb.nodesource.com/node_22.x nodistro main'
GHCLI='deb [arch=amd64 trusted=yes] https://cli.github.com/packages stable main'

apt_step() { # <source dir> <packages...>
  local dir="$1"
  shift
  apt_get "$dir" update
  apt_get "$dir" install --no-install-recommends --download-only "$@"
  rm -rf "${WORK:?}/cache/archives/"*
}

# --------------------------------------------------------------------- stages
step_scrapling_apt() { apt_step "$(sources scrapling)" python3 python3-venv ca-certificates; }
step_scrapling_venv() {
  python3 -m venv "$WORK/scrapling-venv"
  "$WORK/scrapling-venv/bin/pip" install --quiet --cache-dir "$WORK/pip-cache" \
    -c "$DOCKER_DIR/scrapling-constraints.txt" \
    'scrapling[fetchers]' markdownify beautifulsoup4
  rm -rf "$WORK"/scrapling-venv/lib/python*/site-packages/playwright/driver
}
step_websearch_venv() {
  python3 -m venv "$WORK/web-search-venv"
  "$WORK/web-search-venv/bin/pip" install --quiet --cache-dir "$WORK/pip-cache" \
    ddgs 'idna>=3.15' 'anyio>=4.14.2'
  rm -rf "$WORK/web-search-venv" "$WORK/pip-cache"
}
step_chromium() {
  PLAYWRIGHT_BROWSERS_PATH="$WORK/browsers" \
    "$WORK/scrapling-venv/bin/python" -m patchright install chromium
  ls -d "$WORK/browsers"/chromium-* >/dev/null
  rm -rf "$WORK/browsers" "$WORK/scrapling-venv"
}

step_agent_apt1() { apt_step "$(sources agent1)" curl gnupg ca-certificates; }
step_agent_nodesource() {
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$WORK/nodesource-setup.sh"
  apt_step "$(sources agent2 "$NODESOURCE")" nodejs
}
step_agent_apt3() {
  apt_step "$(sources agent3)" python3 python3-pip python3-venv jq unzip universal-ctags \
    ripgrep fd-find git make gosu libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libnspr4 libnss3 libpango-1.0-0 libxcomposite1 \
    libxdamage1 libxkbcommon0 libxfixes3 libxrandr2 fonts-noto-color-emoji
}
step_agent_gh() {
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$WORK/gh.gpg" && rm -f "$WORK/gh.gpg"
  apt_step "$(sources agent4 "$GHCLI")" gh
}
step_agent_npm_globals() {
  npm install -g --force --prefix "$WORK/npm-global" --cache "$WORK/npm-cache" --no-audit --no-fund \
    @ast-grep/cli eslint jscpd prettier pyright shell-quote@1.11.0 typescript \
    typescript-language-server
  rm -rf "$WORK/npm-global"
}
step_agent_rust_analyzer() {
  local asset="rust-analyzer-$(uname -m)-unknown-linux-gnu.gz"
  curl -fsSL --retry 5 --retry-all-errors \
    "https://github.com/rust-lang/rust-analyzer/releases/download/2026-08-10.1/${asset}" \
    -o "$WORK/$asset"
  gunzip -f "$WORK/$asset"
  rm -f "$WORK/${asset%.gz}"
}
step_agent_rtk() {
  RTK_VERSION=v0.45.0 RTK_INSTALL_DIR="$WORK/bin" \
    sh -c 'curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh'
  rm -rf "$WORK/bin"
}
step_agent_osv() {
  local asset="osv-scanner_linux_amd64"
  curl -fsSL --retry 5 --retry-all-errors \
    "https://github.com/google/osv-scanner/releases/download/v2.4.0/${asset}" -o "$WORK/$asset"
  chmod +x "$WORK/$asset"
  rm -f "$WORK/$asset"
}
step_agent_go() {
  local asset="go1.25.8.linux-amd64.tar.gz"
  curl -fsSL --retry 5 --retry-all-errors "https://go.dev/dl/${asset}" -o "$WORK/$asset"
  mkdir -p "$WORK/goroot"
  tar -C "$WORK/goroot" -xzf "$WORK/$asset"
  rm -rf "$WORK/goroot" "$WORK/$asset"
}
step_agent_clone() {
  git -c "http.proxy=$PROXY" clone --quiet --depth 1 --branch main \
    https://github.com/SchneiderDaniel/cheasee-pi "$WORK/clone"
  mkdir -p "$WORK/clone-ci"
  cp "$WORK/clone/package.json" "$WORK/clone/package-lock.json" "$WORK/clone-ci/"
  ( cd "$WORK/clone-ci" &&
      npm ci --no-audit --no-fund --cache "$WORK/npm-cache" >/dev/null )
  rm -rf "$WORK/clone" "$WORK/clone-ci"
}
step_agent_pi() {
  npm install -g --force --prefix "$WORK/pi-prefix" --cache "$WORK/npm-cache" \
    --no-audit --no-fund @earendil-works/pi-coding-agent@1.0.2
  rm -rf "$WORK/pi-prefix" "$WORK/npm-cache"
}

# ----------------------------------------------------------------------- main
mkdir -p "$WORK/cache/archives" "$WORK/lists" "$WORK/aptconf" "$WORK/bin"
cp /etc/apt/apt.conf.d/* "$WORK/aptconf/" 2>/dev/null || true
# The Dockerfile deletes this hook before every apt RUN: it would wipe the
# archive cache the cache mounts exist to reuse. Mirror that.
rm -f "$WORK/aptconf/docker-clean"

echo "Measuring $BASE_IMAGE on $(uname -sm), $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
echo "Counting proxy on $PROXY; downloads go to $WORK and are deleted per step." >&2
echo >&2
printf '| Stage | Step | Observed transfer | Observed time |\n'
printf '| ----- | ---- | ----------------- | ------------- |\n'

measure scrapling "base image ${BASE_TAG}@${BASE_DIGEST:0:19}… (pull, one layer)" fetch_base_image

measure scrapling "apt: python3, python3-venv, ca-certificates (index + archives)" step_scrapling_apt
measure scrapling "pip: scrapling[fetchers] + markdownify + beautifulsoup4 (constraints-pinned)" step_scrapling_venv
measure scrapling "pip: ddgs + idna + anyio (web-search venv)" step_websearch_venv
measure scrapling "patchright install chromium (chromium + headless shell + ffmpeg)" step_chromium
subtotal scrapling scrapling

measure agent "apt: curl, gnupg, ca-certificates" step_agent_apt1
measure agent "NodeSource setup_22.x + apt: nodejs" step_agent_nodesource
measure agent "apt: toolchain + Playwright system libraries (26 packages)" step_agent_apt3
measure agent "GitHub CLI keyring + apt: gh" step_agent_gh
measure agent "npm globals: ast-grep, eslint, jscpd, prettier, pyright, shell-quote, typescript, typescript-language-server" step_agent_npm_globals
measure agent "rust-analyzer 2026-08-10.1" step_agent_rust_analyzer
measure agent "rtk 0.45.0 (install.sh + release asset)" step_agent_rtk
measure agent "osv-scanner 2.4.0" step_agent_osv
measure agent "Go 1.25.8 toolchain (download + unpack)" step_agent_go
measure agent "cheasee-pi clone (depth 1) + npm ci" step_agent_clone
measure agent "@earendil-works/pi-coding-agent 1.0.2" step_agent_pi
subtotal agent agent

printf '| **both** | **cold build transfer** | **%s B** | **%s s** |\n' \
  "$(group "$TOTAL_BYTES")" "$(secs "$TOTAL_NS")"
echo >&2
echo "Total: $(group "$TOTAL_BYTES") B in $(secs "$TOTAL_NS") s (measured on this host;" >&2
echo "docker layer commit time and dpkg unpack are not part of this number)." >&2
