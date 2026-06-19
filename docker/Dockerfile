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
        jscpd \
        typescript

# ---------------------------------------------------------------
# Layer 6: Non-root user + workspace directory
# ---------------------------------------------------------------
RUN groupadd --gid 1001 agentuser && \
    useradd --uid 1001 --gid agentuser --create-home --shell /bin/bash agentuser && \
    mkdir -p /workspaces/main /home/agentuser/.config && \
    chown -R agentuser:agentuser /workspaces/main /home/agentuser

# ---------------------------------------------------------------
# Layer 7: Entrypoint (last – changes most frequently)
# ---------------------------------------------------------------
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspaces/main

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
