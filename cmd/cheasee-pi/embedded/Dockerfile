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
ARG PI_VERSION=latest
RUN npm install -g --force \
        @earendil-works/pi-coding-agent@${PI_VERSION} \
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
# Layer 6: Non-root user + workspace directory
# ---------------------------------------------------------------
RUN groupadd --gid 1001 agentuser && \
    useradd --uid 1001 --gid agentuser --create-home --shell /bin/bash agentuser && \
    mkdir -p /workspaces/main /home/agentuser/.config && \
    chown -R agentuser:agentuser /workspaces/main /home/agentuser

# ---------------------------------------------------------------
# Layer 7: Entrypoint + worktree fix library (last – changes most frequently)
# ---------------------------------------------------------------
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/lib/ /usr/local/bin/lib/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/lib/worktree-fix.sh

WORKDIR /workspaces/main

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
