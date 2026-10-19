# Cheasee-Pi — OCI-compliant container image
# ===========================================
# Build:  docker build -t cheasee-pi .
# Run:    docker run cheasee-pi pi --version

# Base image, pinned by manifest-list digest (issue #2053): an upstream retag
# cannot invalidate every layer below it. Pin the manifest LIST digest, not a
# per-platform manifest digest, or the other architecture breaks. Rotation
# cadence + procedure: docs/security.md.
ARG BASE_IMAGE=debian:12-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

# ---------------------------------------------------------------
# Stage: scrapling — Python venvs + Chromium browser cache
# ---------------------------------------------------------------
# Isolated on purpose (issue #2053): this stage is fed by BASE_IMAGE and
# scrapling-constraints.txt only, so a change to any agent-stage layer copies
# /opt/venvs and /opt/playwright-browsers from cache instead of re-fetching
# the ~646M browser bundle. That is the cache-evicted case (#2050); cache
# mounts alone only cheapen a re-run of the same cached layer.
#
# It deliberately does NOT inherit the agent stage: the venv is not relocatable
# across python builds, so both stages must resolve the identical BASE_IMAGE
# digest — one shared ARG, so a divergence can only be introduced by editing
# the FROM lines (a test pins it). Duplicating python3/python3-venv here costs
# one cache-mounted apt layer.
FROM ${BASE_IMAGE} AS scrapling

# Every apt RUN below starts by deleting /etc/apt/apt.conf.d/docker-clean. The
# Debian base images ship that hook, and its DPkg::Post-Invoke deletes
# /var/cache/apt/archives/*.deb after each apt run — under a /var/cache/apt
# cache mount that empties the archive cache the mount exists to reuse. It also
# blanks Dir::Cache::pkgcache, which lives in the same mount. (The copy is a
# layer file, not a mount target, so removing it is safe for the cache.)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
        ca-certificates

# scrapling venv: progressive web crawler (patchright-driven stealth).
# Installed against scrapling-constraints.txt: `scrapling[fetchers]` floats its
# browser drivers, and a floating patchright resolution is how the baked browser
# cache and the runtime ended up on different chromium revisions (#1986).
# The constraints file is COPY-ed into the agent stage as well — the runtime
# venv re-creation there needs the same pins.
COPY scrapling-constraints.txt /opt/venvs/scrapling-constraints.txt

# web_search venv: ddgs (DuckDuckGo search). idna pinned to the
# post-CVE-2026-45409 release — an old ddgs resolution pulls requests → idna,
# and idna<3.15 is DoS-vulnerable on crafted long inputs. anyio pinned to the
# release fixing GHSA-82r6-8w77-94w6 (CVE-2026-63374) and GHSA-5p39-cfhj-2xmp
# (CVE-2026-64847); both fixed in 4.14.2.
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m venv /opt/venvs/web-search-venv --clear && \
    /opt/venvs/web-search-venv/bin/pip install ddgs 'idna>=3.15' 'anyio>=4.14.2'

# No --no-cache-dir: the pip mount above is the cache a re-run reads, and
# --no-cache-dir would leave it empty. The mount never enters the layer, so the
# wheels are not shipped in the image either.
RUN --mount=type=cache,target=/root/.cache/pip \
    python3 -m venv /opt/venvs/scrapling-venv --clear && \
    /opt/venvs/scrapling-venv/bin/pip install \
        -c /opt/venvs/scrapling-constraints.txt \
        scrapling[fetchers] \
        markdownify \
        beautifulsoup4 \
    && rm -rf /opt/venvs/scrapling-venv/lib/python*/site-packages/playwright/driver \
    && rm -rf /tmp/*
# scrapling imports only `playwright._impl._errors`; the stealth tier launches
# through patchright's own driver. playwright's driver/ bundle (132M) is
# therefore dead weight in this venv.

# Pre-download Chromium for the scrapling stealth fetcher. Must use patchright,
# NOT playwright: the stealth tier (StealthyFetcher) resolves its browser via
# patchright's registry, and the two registries pin different revisions — so a
# playwright-installed build never matches. The revision is read from the venv's
# own patchright/driver/package/browsers.json (pinned above); nothing is
# hardcoded here.
# Retry loop handles the ~646M/arch download (chromium + headless shell + ffmpeg)
# which can glitch on slow/unstable connections. The `test -f` guard after the
# loop keeps a total download failure fatal: the loop tail (`sleep 5`, exit 0)
# would otherwise let the layer report success with an empty browser cache — and
# asserting the *expected* revision is what makes a mismatched cache (the #1986
# root cause: chromium-1243 baked while patchright looks for 1234) a build
# failure instead of a 8-minute runtime stall.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN for i in 1 2 3; do \
      /opt/venvs/scrapling-venv/bin/python -m patchright install chromium \
        && break; \
      echo "[attempt $i] patchright install chromium failed, retrying in 5s…"; \
      sleep 5; \
    done && \
    rev="$(/opt/venvs/scrapling-venv/bin/python -c "import json, pathlib, patchright; print(next(b['revision'] for b in json.loads((pathlib.Path(patchright.__file__).parent / 'driver/package/browsers.json').read_text())['browsers'] if b['name'] == 'chromium'))")" && \
    test -f "/opt/playwright-browsers/chromium-$rev/chrome-linux64/chrome" && \
    chmod -R a+rX /opt/playwright-browsers

# World-readable so agentuser (created in the agent stage) can use the copies;
# COPY --from preserves these modes. Own layer, after the browser download, so
# a venv change does not invalidate the ~646M fetch above it.
RUN chmod -R a+rX /opt/venvs

# ---------------------------------------------------------------
# Stage: agent — the shipped image (final stage)
# ---------------------------------------------------------------
FROM ${BASE_IMAGE} AS agent

# ---------------------------------------------------------------
# Layer 1: Base dependencies (curl, gnupg, ca-certificates)
# ---------------------------------------------------------------
# Cache mounts, not extra layers: re-running this step re-reads the downloaded
# .deb archives from the builder cache instead of the network. /var/lib/apt is
# mounted too, so its cleanup is gone — `rm -rf /var/lib/apt/lists/*` would
# throw away the cached lists, the very download the mount exists to avoid.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        gnupg \
        ca-certificates

# ---------------------------------------------------------------
# Layer 2: Node.js 22.x via NodeSource
# ---------------------------------------------------------------
# Curl-to-file (not a pipe): if deb.nodesource.com is unreachable, curl fails
# and the RUN aborts loudly instead of the pipe silently falling back to
# Debian's nodejs (which ships without npm). The v22/npm assertions pin the
# result so a future fallback can never be cached as "successful" again.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    curl -fsSL -o /tmp/nodesource-setup.sh https://deb.nodesource.com/setup_22.x && \
    bash /tmp/nodesource-setup.sh && \
    apt-get install -y --no-install-recommends \
        nodejs \
    && rm -rf /tmp/nodesource-setup.sh \
    && node --version | grep -q '^v22\.' \
    && test -x /usr/bin/npm \
    && rm -rf /usr/include/node
# /usr/include/node (65M) is node-gyp's build-time header tree. Every dependency
# baked here or installed by the workspace entrypoint is prebuilt or pure JS, so
# no native compile reads it. Re-add if a workspace dependency ever needs gyp.

# ---------------------------------------------------------------
# Layer 3: Toolchain packages (Python, ctags, ripgrep, gosu, …)
#          + Playwright system libraries for scrapling Chromium fetcher
# ---------------------------------------------------------------
# Enable Noto Color Emoji as fallback for emoji/icon characters
# The package installs fonts in /usr/share/fonts/truetype/noto/
# and a fontconfig snippet in /etc/fonts/conf.avail/66-noto-color-emoji.conf
# fd-find ships as fdfind; symlink to fd so pi finds it
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        jq \
        unzip \
        universal-ctags \
        ripgrep \
        fd-find \
        git \
        make \
        gosu \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libxcomposite1 \
        libxdamage1 \
        libxkbcommon0 \
        libxfixes3 \
        libxrandr2 \
        fonts-noto-color-emoji \
    && fc-cache -f \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

# ---------------------------------------------------------------
# Layer 4: GitHub CLI
# ---------------------------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /tmp/*

# ---------------------------------------------------------------
# Layer 5: npm global tools
# ---------------------------------------------------------------
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --force \
        @ast-grep/cli \
        eslint \
        jscpd \
        prettier \
        pyright \
        shell-quote@1.11.0 \
        typescript \
        typescript-language-server \
    && rm -rf /usr/lib/node_modules/@ast-grep/cli/node_modules \
              /usr/lib/node_modules/jscpd/node_modules/jscpd-linux-* \
    && rm -rf /tmp/*
# @ast-grep/cli's postinstall copies the platform binary up to cli/ast-grep
# (the /usr/bin symlink target); the nested platform package (51M) is a leftover
# duplicate. jscpd-linux-* (45M) is an optional prebuilt the JS CLI does not
# need. Both were removed and the tools re-verified.

# ---------------------------------------------------------------
# Layer 5b: LSP server binaries (rust-analyzer, gopls)
# Downloads static binaries — no Rust/Go toolchain needed.
# Pinned tag (not latest) for reproducibility; --retry-all-errors because
# transfers from release-assets.githubusercontent.com die mid-flight on
# flaky connections (curl 56, "Connection died").
# ---------------------------------------------------------------
ARG RA_VERSION=2026-08-10.1
# uname -m yields exactly x86_64/aarch64 (emulated arch under qemu) — the
# rust-analyzer asset names; other arches 404 (curl exit 22).
RUN ra_asset="rust-analyzer-$(uname -m)-unknown-linux-gnu.gz" && \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 "https://github.com/rust-lang/rust-analyzer/releases/download/${RA_VERSION}/${ra_asset}" -o "/tmp/${ra_asset}" && \
    gunzip "/tmp/${ra_asset}" && \
    install -m 755 "/tmp/${ra_asset%.gz}" /usr/local/bin/rust-analyzer && \
    rm -f "/tmp/${ra_asset%.gz}"

# ---------------------------------------------------------------
# Layer 5c: rtk binary (Rust CLI — token-saving bash rewrite)
# Installs to /usr/local/bin/rtk for all users.
# Pinned + retry loop: rtk's own install.sh curls the GitHub release asset
# without --retry, and transfers from release-assets die mid-flight on
# flaky connections (curl 56, "Connection died"). `test -x` after the loop
# keeps a total failure fatal (the playwright loop above can't say that).
# ---------------------------------------------------------------
ARG RTK_VERSION=0.45.0
RUN for i in 1 2 3; do \
        RTK_VERSION=v${RTK_VERSION} RTK_INSTALL_DIR=/usr/local/bin sh -c "\
            curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh \
                && rtk --version \
            " \
        && break; \
        echo "[attempt $i] rtk install failed, retrying in 5s…"; \
        sleep 5; \
    done && \
    test -x /usr/local/bin/rtk

# ---------------------------------------------------------------
# Layer 5d: Set UTF-8 locale for Unicode/emoji support
# ---------------------------------------------------------------
ENV LANG=C.UTF-8 LC_CTYPE=C.UTF-8 LC_ALL=C.UTF-8

# ---------------------------------------------------------------
# Layer 5e: Python venvs + Chromium browser cache (copied in)
# ---------------------------------------------------------------
# Both artifacts are produced in the isolated `scrapling` stage at the top of
# this file, so nothing below re-downloads them. Copying (instead of
# re-creating here) is also what keeps the patchright↔chromium revision
# binding in exactly one place: the agent stage never resolves browsers.json.
COPY --from=scrapling /opt/venvs/scrapling-venv /opt/venvs/scrapling-venv
COPY --from=scrapling /opt/venvs/web-search-venv /opt/venvs/web-search-venv
COPY --from=scrapling /opt/playwright-browsers /opt/playwright-browsers
# Runtime venv re-creation (a workspace without the baked copy) uses the same
# pins, so an in-container `pip install` cannot reintroduce the drift.
COPY scrapling-constraints.txt /opt/venvs/scrapling-constraints.txt
# ENV does not cross stages: the browser path (entrypoint.sh resolves it before
# ~/.cache/ms-playwright) and the constraints pin must exist in the runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
ENV SCRAPLING_PIP_CONSTRAINTS=/opt/venvs/scrapling-constraints.txt

# The stamp file is the baked venv's identity (pip freeze hash): entrypoint.sh
# re-copies the venv into the workspace when the copy's stamp or ownership
# drifts, so a stale root-owned .pi/scrapling-venv cannot shadow the baked one
# (#1986). Written AFTER the COPYs so it hashes the venv that actually ships.
RUN for v in web-search-venv scrapling-venv; do \
      "/opt/venvs/$v/bin/pip" freeze | sort | sha256sum | cut -d' ' -f1 > "/opt/venvs/$v/.cheasee-venv-stamp"; \
    done && \
    rm -rf /tmp/*

# ---------------------------------------------------------------
# Layer 5f: osv-scanner binary (prebuilt release — no Go toolchain)
# Vulnerability scanner for 19+ lockfile types across 11+ ecosystems.
# Pinned to v2.4.0 per research (Jun 18, 2026).
# ---------------------------------------------------------------
ARG OSV_SCANNER_VERSION=2.4.0
# osv-scanner asset names are dpkg arches (amd64/arm64). curl --retry-all-errors
# (covers mid-flight curl 56 deaths plain --retry skips) replaces the shell
# retry wrapper; --retry-delay 2 keeps failure latency ≈ parity.
RUN osv_asset="osv-scanner_linux_$(dpkg --print-architecture)" && \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/${osv_asset}" -o "/usr/local/bin/osv-scanner" && \
    chmod +x /usr/local/bin/osv-scanner && \
    osv-scanner --version

# ---------------------------------------------------------------
# Layer 5g: Go toolchain (for building cheasee-pi CLI)
# Pinned to Go 1.25.x for compatibility with huh v2.0.3 (requires go >= 1.25.8).
# ---------------------------------------------------------------
ARG GO_VERSION=1.25.8
# dpkg --print-architecture yields exactly amd64/arm64 — Go's asset names.
RUN go_asset="go${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz" && \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 "https://go.dev/dl/${go_asset}" -o "/tmp/${go_asset}" && \
    tar -C /usr/local -xzf "/tmp/${go_asset}" && \
    rm -f "/tmp/${go_asset}" && \
    /usr/local/go/bin/go version && \
    rm -rf /usr/local/go/test /usr/local/go/api /usr/local/go/doc /usr/local/go/misc
# test/ api/ doc/ misc/ are for Go's own test suite, API-compat tooling and
# docs — not for `go build`/`go test` of this module. ~29M, no build input.

ENV PATH=/usr/local/go/bin:${PATH}

# ---------------------------------------------------------------
# Layer 6: Non-root user + workspace directory
# ---------------------------------------------------------------
RUN groupadd --gid 1001 agentuser && \
    useradd --uid 1001 --gid agentuser --create-home --shell /bin/bash agentuser && \
    mkdir -p /workspaces/main /home/agentuser/.config && \
    chown agentuser:agentuser /workspaces && \
    chown -R agentuser:agentuser /workspaces/main /home/agentuser

# ---------------------------------------------------------------
# Layer 6b: Cheasee-Pi resources cloned into the image
# ---------------------------------------------------------------
# The cheasee-pi repo is cloned to /opt/cheasee-pi and its resource dirs
# (.pi/skills, .pi/prompts, .pi/extensions, .pi/themes) symlinked into
# agentuser's global pi resource dir (~/.pi/agent) so the Cheasee-Pi
# experience is available inside ANY mounted repo. The global operating
# instructions (APPEND_SYSTEM.md at repo root) are symlinked the same way
# into ~/.pi/agent/APPEND_SYSTEM.md — pi appends that file to the system
# prompt in every repository. Cloning (vs embedding a generated copy into
# the Go binary) keeps the repo the single source of truth — no
# pi-resources mirror to sync.
#
# Explicit /home/agentuser/.pi/agent/... paths — Docker's USER directive
# does not set $HOME (defaults to /root), so `~` after a user switch would
# silently drop the links into /root/.pi/agent.
#
# private-pi/ is gitignored (never tracked), so a clone cannot include it —
# the symlink is conditional and appears only when /opt/cheasee-pi carries it.
#
# MARKER CONTRACT (dogfooding, consumed by entrypoint.sh at runtime): when the
# mounted repo is detected as cheasee-pi (cmd/cheasee-pi/embedded/docker/ dir
# present AND go.mod declares module github.com/SchneiderDaniel/cheasee-pi),
# the entrypoint re-points these global symlinks at the LIVE repo so pi's
# realpath-based dedup collapses the global + project loads into one. The
# marker is structural, not content-based, and covers the upstream module
# only — renamed-module forks don't match and keep this baked copy.
#
# ponytail is removed: it loads hooks from the gitignored .pi/git vendored
# clone (absent on fresh clones), and a failed extension load kills pi boot.
#
# INTENTIONAL DEVIATION FROM PI'S PACKAGE MECHANISM: the baked /opt/cheasee-pi
# copy is PRODUCT DATA — image-scoped, CHEASEE_REF-pinned, and covered by the
# re_point marker contract above. It is deliberately NOT a pi package: no pi
# git-folder layout (.pi/git/<host>/<path>), no npm-install-on-install. User
# skill repos are WORKSPACE DATA — recorded in cheasee-settings.json
# (skillRepos) at init and installed by the entrypoint via `pi install -l -a`
# into .pi/git/ on container start. Aligning the baked copy with the pi
# package layout would run a second npm install at build and break the
# dogfooding dedup.
ARG CHEASEE_REF=main
RUN --mount=type=cache,target=/root/.npm \
    git clone --depth 1 --branch ${CHEASEE_REF} https://github.com/SchneiderDaniel/cheasee-pi /opt/cheasee-pi \
    && rm -rf /opt/cheasee-pi/.git /opt/cheasee-pi/.pi/extensions/ponytail \
    && cd /opt/cheasee-pi && npm ci --no-audit --no-fund \
    && rm -rf /opt/cheasee-pi/node_modules/@earendil-works \
              /opt/cheasee-pi/node_modules/typebox \
              /opt/cheasee-pi/node_modules/@sinclair
# An empty glob (e.g. .pi/prompts has no entries yet) leaves the loop's last
# command as `[ -e "$d" ]` → exit 1 → the && chain dies. `|| continue` makes
# unmatched globs a no-op while real ln failures still propagate.
RUN mkdir -p /home/agentuser/.pi/agent/skills /home/agentuser/.pi/agent/prompts /home/agentuser/.pi/agent/extensions /home/agentuser/.pi/agent/themes \
    && for t in skills prompts extensions themes; do for d in /opt/cheasee-pi/.pi/$t/*; do [ -e "$d" ] || continue; ln -sfn "$d" /home/agentuser/.pi/agent/$t/; done; done \
    && if [ -d /opt/cheasee-pi/custom ]; then ln -sfn /opt/cheasee-pi/custom /home/agentuser/.pi/agent/custom; fi \
    && if [ -d /opt/cheasee-pi/private-pi ]; then \
         for t in skills prompts; do for d in /opt/cheasee-pi/private-pi/$t/*; do [ -e "$d" ] || continue; ln -sfn "$d" /home/agentuser/.pi/agent/$t/; done; done \
         && mkdir -p /home/agentuser/.pi/agent/extensions \
         && ln -sfn /opt/cheasee-pi/private-pi/extensions/check-extensions /home/agentuser/.pi/agent/extensions/check-extensions; \
       fi \
    && if [ -f /opt/cheasee-pi/APPEND_SYSTEM.md ]; then ln -sfn /opt/cheasee-pi/APPEND_SYSTEM.md /home/agentuser/.pi/agent/APPEND_SYSTEM.md; fi \
    && chown -R agentuser:agentuser /home/agentuser/.pi

# ---------------------------------------------------------------
# Layer 6c: pi-coding-agent (last npm layer — pi bumps don't
#           invalidate the expensive clone/npm-ci layer above)
# ---------------------------------------------------------------
# Placed AFTER Layer 6b (clone + npm ci + symlink wiring) so a pi update —
# every build busts this layer via PI_BUILD_STAMP — only re-runs this npm
# install; the expensive clone/npm-ci layers stay cached. Kept BEFORE
# Layer 7's entrypoint COPY because that layer changes most frequently:
# if pi sat absolute-last, every entrypoint/lib change would reinstall it.
# PI_VERSION defaults to the pinned released version (matches the compose
# default); `PI_VERSION=latest` is the explicit override.
ARG PI_VERSION=1.0.2
# Cache-busting stamp: any change to this ARG invalidates the npm layer, so
# the requested PI_VERSION is re-resolved on every build instead of reusing a
# stale layer. Scoped to this service by docker-compose.yml build.args (the
# CLI supplies it via the compose env); the ui sidecar deliberately does not
# declare it.
ARG PI_BUILD_STAMP
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --force @earendil-works/pi-coding-agent@${PI_VERSION} \
    && rm -rf /tmp/* \
    && echo "${PI_BUILD_STAMP}" >/var/lib/pi-build-stamp

# ---------------------------------------------------------------
# Layer 7: Entrypoint + worktree fix library (last – changes most frequently)
# ---------------------------------------------------------------
# Build context is the CLI cache dir (compose `context: .`), so the entrypoint
# and lib/ sit at the context root — no docker/ prefix.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY lib/ /usr/local/bin/lib/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/lib/worktree-fix.sh \
    && node /usr/local/bin/lib/patch-pi-session-warning.js

WORKDIR /workspaces/main

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
