# Cheasee-Pi — OCI-compliant container image
# ===========================================
# Build:  docker build -t cheasee-pi .
# Run:    docker run cheasee-pi pi --version

FROM debian:12-slim

# ---------------------------------------------------------------
# Layer 1: Base dependencies (curl, gnupg, ca-certificates)
# ---------------------------------------------------------------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        gnupg \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------
# Layer 2: Node.js 22.x via NodeSource
# ---------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends \
        nodejs \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------
# Layer 3: Toolchain packages (Python, ctags, ripgrep, gosu, …)
#          + Playwright system libraries for scrapling Chromium fetcher
# ---------------------------------------------------------------
RUN apt-get update && \
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
        wget \
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
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Enable Noto Color Emoji as fallback for emoji/icon characters
# The package installs fonts in /usr/share/fonts/truetype/noto/
# and a fontconfig snippet in /etc/fonts/conf.avail/66-noto-color-emoji.conf
RUN fc-cache -f -v

# fd-find ships as fdfind; symlink to fd so pi finds it
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd

# ---------------------------------------------------------------
# Layer 4: GitHub CLI
# ---------------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /root/.cache/* /tmp/* && \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------
# Layer 5: npm global tools
# ---------------------------------------------------------------
RUN npm install -g --force \
        @ast-grep/cli \
        eslint \
        jscpd \
        prettier \
        pyright \
        shell-quote \
        typescript \
        typescript-language-server \
    && npm cache clean --force \
    && rm -rf /tmp/*

# ---------------------------------------------------------------
# Layer 5b: LSP server binaries (rust-analyzer, gopls)
# Downloads static binaries — no Rust/Go toolchain needed.
# ---------------------------------------------------------------
RUN case "$(dpkg --print-architecture)" in \
        amd64) \
            ra_asset="rust-analyzer-x86_64-unknown-linux-gnu.gz" ;; \
        arm64) \
            ra_asset="rust-analyzer-aarch64-unknown-linux-gnu.gz" ;; \
        *) echo "Unsupported arch: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/rust-lang/rust-analyzer/releases/latest/download/${ra_asset}" -o "/tmp/${ra_asset}" && \
    gunzip "/tmp/${ra_asset}" && \
    install -m 755 "/tmp/${ra_asset%.gz}" /usr/local/bin/rust-analyzer && \
    rm -f "/tmp/${ra_asset%.gz}"

# ---------------------------------------------------------------
# Layer 5c: rtk binary (Rust CLI — token-saving bash rewrite)
# Installs to /usr/local/bin/rtk for all users.
# ---------------------------------------------------------------
RUN RTK_INSTALL_DIR=/usr/local/bin sh -c "\
    curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh \
        && rtk --version \
    "

# ---------------------------------------------------------------
# Layer 5d: Set UTF-8 locale for Unicode/emoji support
# ---------------------------------------------------------------
ENV LANG=C.UTF-8
ENV LC_CTYPE=C.UTF-8
ENV LC_ALL=C.UTF-8

# ---------------------------------------------------------------
# Layer 5e: Pre-built Python venvs for web_search + web_crawl
#           Packages + Chromium pre-installed so agent workflows
#           skip first-call venv setup.
# ---------------------------------------------------------------
# web_search venv: ddgs (DuckDuckGo search)
RUN python3 -m venv /opt/venvs/web-search-venv --clear && \
    /opt/venvs/web-search-venv/bin/pip install --no-cache-dir ddgs

# scrapling venv: progressive web crawler (Playwright stealth)
RUN python3 -m venv /opt/venvs/scrapling-venv --clear && \
    /opt/venvs/scrapling-venv/bin/pip install --no-cache-dir \
        scrapling[fetchers] \
        markdownify \
        beautifulsoup4 \
    && rm -rf /root/.cache/pip /tmp/*

# Pre-download Chromium browser for scrapling Playwright fetcher
# Retry loop handles the ~175 MB download which can glitch on slow/unstable connections.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN for i in 1 2 3; do \
      /opt/venvs/scrapling-venv/bin/python -m playwright install chromium \
        && break; \
      echo "[attempt $i] playwright install chromium failed, retrying in 5s…"; \
      sleep 5; \
    done && \
    chmod -R a+rX /opt/playwright-browsers

# World-readable so agentuser (created next layer) can access
RUN chmod -R a+rX /opt/venvs && \
    rm -rf /root/.cache/* /tmp/*

# ---------------------------------------------------------------
# Layer 5f: osv-scanner binary (prebuilt release — no Go toolchain)
# Vulnerability scanner for 19+ lockfile types across 11+ ecosystems.
# Pinned to v2.4.0 per research (Jun 18, 2026).
# ---------------------------------------------------------------
ARG OSV_SCANNER_VERSION=2.4.0
RUN case "$(dpkg --print-architecture)" in \
        amd64) \
            osv_asset="osv-scanner_linux_amd64" ;; \
        arm64) \
            osv_asset="osv-scanner_linux_arm64" ;; \
        *) echo "Unsupported arch: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/${osv_asset}" -o "/usr/local/bin/osv-scanner" && \
    chmod +x /usr/local/bin/osv-scanner && \
    osv-scanner --version

# ---------------------------------------------------------------
# Layer 5g: Go toolchain (for building cheasee-pi CLI)
# Pinned to Go 1.25.x for compatibility with huh v2.0.3 (requires go >= 1.25.8).
# ---------------------------------------------------------------
ARG GO_VERSION=1.25.8
RUN case "$(dpkg --print-architecture)" in \
        amd64) \
            go_asset="go${GO_VERSION}.linux-amd64.tar.gz" ;; \
        arm64) \
            go_asset="go${GO_VERSION}.linux-arm64.tar.gz" ;; \
        *) echo "Unsupported arch: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://go.dev/dl/${go_asset}" -o "/tmp/${go_asset}" && \
    tar -C /usr/local -xzf "/tmp/${go_asset}" && \
    rm -f "/tmp/${go_asset}" && \
    /usr/local/go/bin/go version

ENV PATH=/usr/local/go/bin:${PATH}

# ---------------------------------------------------------------
# Layer 5h: pi-coding-agent (last npm layer — pi version bumps
#           don't invalidate expensive binary layers above)
# ---------------------------------------------------------------
ARG PI_VERSION=latest
# Cache-busting stamp: any change to this ARG invalidates the npm layer,
# so @latest is re-resolved on every build instead of reusing a stale layer.
# Set it to a per-build value (e.g. $(date +%s)) via `docker compose build
# --build-arg PI_BUILD_STAMP=$(date +%s)`.
ARG PI_BUILD_STAMP
RUN npm install -g --force @earendil-works/pi-coding-agent@${PI_VERSION} \
    && npm cache clean --force \
    && rm -rf /tmp/* \
    && echo "${PI_BUILD_STAMP}" >/var/lib/pi-build-stamp

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
# experience is available inside ANY mounted repo. Cloning (vs embedding a
# generated copy into the Go binary) keeps the repo the single source of
# truth — no pi-resources mirror to sync.
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
ARG CHEASEE_REF=main
RUN git clone --depth 1 --branch ${CHEASEE_REF} https://github.com/SchneiderDaniel/cheasee-pi /opt/cheasee-pi \
    && rm -rf /opt/cheasee-pi/.git /opt/cheasee-pi/.pi/extensions/ponytail \
    && cd /opt/cheasee-pi && npm ci --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /opt/cheasee-pi/node_modules/@earendil-works \
              /opt/cheasee-pi/node_modules/typebox \
              /opt/cheasee-pi/node_modules/@sinclair
# An empty glob (e.g. .pi/prompts has no entries yet) leaves the loop's last
# command as `[ -e "$d" ]` → exit 1 → the && chain dies. `|| continue` makes
# unmatched globs a no-op while real ln failures still propagate.
RUN mkdir -p /home/agentuser/.pi/agent/skills /home/agentuser/.pi/agent/prompts /home/agentuser/.pi/agent/extensions /home/agentuser/.pi/agent/themes \
    && for d in /opt/cheasee-pi/.pi/skills/*; do [ -e "$d" ] || continue; ln -sfn "$d" /home/agentuser/.pi/agent/skills/; done \
    && for d in /opt/cheasee-pi/.pi/prompts/*; do [ -e "$d" ] || continue; ln -sfn "$d" /home/agentuser/.pi/agent/prompts/; done \
    && for d in /opt/cheasee-pi/.pi/extensions/*; do [ -e "$d" ] || continue; ln -sfn "$d" /home/agentuser/.pi/agent/extensions/; done \
    && for d in /opt/cheasee-pi/.pi/themes/*; do [ -e "$d" ] || continue; ln -sfn "$d" /home/agentuser/.pi/agent/themes/; done \
    && if [ -d /opt/cheasee-pi/custom ]; then ln -sfn /opt/cheasee-pi/custom /home/agentuser/.pi/agent/custom; fi \
    && if [ -d /opt/cheasee-pi/private-pi ]; then \
         for d in /opt/cheasee-pi/private-pi/skills/*; do [ -e "$d" ] || continue; ln -sfn "$d" /home/agentuser/.pi/agent/skills/; done \
         && for d in /opt/cheasee-pi/private-pi/prompts/*; do [ -e "$d" ] || continue; ln -sfn "$d" /home/agentuser/.pi/agent/prompts/; done \
         && mkdir -p /home/agentuser/.pi/agent/extensions \
         && ln -sfn /opt/cheasee-pi/private-pi/extensions/check-extensions /home/agentuser/.pi/agent/extensions/check-extensions; \
       fi \
    && chown -R agentuser:agentuser /home/agentuser/.pi

# ---------------------------------------------------------------
# Layer 7: Entrypoint + worktree fix library (last – changes most frequently)
# ---------------------------------------------------------------
# Build context is the CLI cache dir (compose `context: .`), so the entrypoint
# and lib/ sit at the context root — no docker/ prefix.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY lib/ /usr/local/bin/lib/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/lib/worktree-fix.sh

WORKDIR /workspaces/main

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
