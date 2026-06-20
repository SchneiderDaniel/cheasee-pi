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
        libxrandr2 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

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
        typescript \
        typescript-language-server

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
