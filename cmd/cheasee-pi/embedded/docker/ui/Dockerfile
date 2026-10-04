# Cheasee-Pi web control center — Axum server + Leptos hydrate shell.
# Multi-stage: a rust builder produces the server binary and the content-hashed
# wasm/CSS bundle via cargo-leptos; the slim runtime serves both.
#
# Toolchain floor: leptos 0.8 MSRV is 1.88, but the fresh `cargo install
# cargo-leptos` below resolves toolchain crates (cargo-util-schemas,
# tokio-process-tools) that already need rustc 1.90+, so the image is pinned
# well above the leptos MSRV. Bump only when an install resolution demands
# newer.
FROM rust:1.99-bookworm AS builder

WORKDIR /build

# wasm target plus the tools cargo-leptos's `no_downloads` build expects on
# PATH: `wasm-opt` (binaryen) and a `wasm-bindgen` CLI. binaryen comes from
# Debian apt; the cargo-leptos prebuilt binary below is the one deliberate
# GitHub-release download in this image, pinned to v0.3.10 and arch-matched.
RUN rustup target add wasm32-unknown-unknown \
 && apt-get update \
 && apt-get install -y --no-install-recommends binaryen \
 && rm -rf /var/lib/apt/lists/*

# Pin cargo-leptos via its prebuilt release binary — a `cargo install` of it
# compiles swc/git2 etc. (≈8 min cold). The download happens once, at image
# build. Read the wasm-bindgen CLI version straight from the committed lock so
# the CLI can never drift from the wasm-bindgen crate it runs.
COPY Cargo.toml Cargo.lock ./
RUN WB="$(sed -n '/^name = "wasm-bindgen"$/{n;s/^version = "\(.*\)"$/\1/p;}' Cargo.lock)" \
 && test -n "$WB" \
 && cargo install wasm-bindgen-cli --version "$WB" --locked \
 && ARCH="$(uname -m)" \
 && case "$ARCH" in \
      x86_64) CL_TRIPLE="x86_64-unknown-linux-gnu" ;; \
      aarch64) CL_TRIPLE="aarch64-unknown-linux-gnu" ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --retry 5 --retry-all-errors \
      "https://github.com/leptos-rs/cargo-leptos/releases/download/v0.3.10/cargo-leptos-${CL_TRIPLE}.tar.gz" -o /tmp/cargo-leptos.tar.gz \
 && tar -xzf /tmp/cargo-leptos.tar.gz -C /tmp \
 && install -m 755 "/tmp/cargo-leptos-${CL_TRIPLE}/cargo-leptos" /usr/local/cargo/bin/cargo-leptos \
 && rm -rf /tmp/cargo-leptos.tar.gz "/tmp/cargo-leptos-${CL_TRIPLE}"

COPY src ./src
# Integration tests + the captured JSONL fixture corpus. Without this COPY the
# image's `cargo test` silently skips tests/ and the AC1/AC2 framing and
# correlation suites would never run in the gate.
COPY tests ./tests
# Embedded at compile time by `include_str!("../provider_env_map.json")` in
# src/auth.rs — must sit next to src/, not inside it. Drift-pinned to
# `cheasee-pi auth envvars --format json` by ui_provider_env_map_test.go.
COPY provider_env_map.json ./
COPY style ./style
# The spawn-path tests assert the child's working directory and pinned session
# dir are the shared workspace mount; this builder stage is not the runtime, so
# create that path for the in-image suite.
RUN mkdir -p /workspaces/main/.pi/sessions
# Run the host-side unit/integration suite (protocol + retry policy, the Axum
# routes, and the real WS loopback upgrade) before building anything. CI has
# no cargo-test job for this crate, so the tests actually run wherever this
# image builds — including the PR smoke gate. Built with the same release
# profile and target dir as the leptos server build below, so the shared dep
# artifacts are compiled once, not twice.
RUN cargo test --release --target-dir target/server --no-default-features --features ssr
# cargo-leptos builds the wasm lib (feature `hydrate`) and the server bin
# (feature `ssr`) per [package.metadata.leptos], then hashes the asset names.
RUN cargo leptos build --release

FROM debian:bookworm-slim

# curl is the compose healthcheck probe; ca-certificates + gnupg back the
# NodeSource repo setup below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && rm -rf /var/lib/apt/lists/*

# Node.js 22 (NodeSource): the runtime for the pi-coding-agent CLI this server
# spawns as its RPC child. Same major as the pi image so the spawned `pi`
# matches the terminal client exactly.
# Curl-to-file (not a pipe): if deb.nodesource.com is unreachable, curl fails
# and the RUN aborts loudly instead of the pipe silently falling back to
# Debian's nodejs (which ships without npm). The v22/npm assertions pin the
# result so a future fallback can never be cached as "successful" again.
RUN curl -fsSL -o /tmp/nodesource-setup.sh https://deb.nodesource.com/setup_22.x \
 && bash /tmp/nodesource-setup.sh \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* /tmp/nodesource-setup.sh \
 && node --version | grep -q '^v22\.' \
 && test -x /usr/bin/npm

# pi-coding-agent — the `pi --mode rpc` child the server spawns (AC3/AC5).
# PI_VERSION is pinned equal to the pi image's value by
# TestUI_DockerfilePiVersionMatchesPiImage so the two clients never diverge.
ARG PI_VERSION=1.0.1
ARG PI_BUILD_STAMP
RUN npm install -g --force @earendil-works/pi-coding-agent@${PI_VERSION} \
 && npm cache clean --force \
 && rm -rf /tmp/* \
 && echo "${PI_BUILD_STAMP}" >/var/lib/pi-build-stamp

# Non-root runtime: the image is a loopback-pinned sidecar; port 3000 is
# unprivileged, so the bind needs no elevation.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin ui

# The auth.json mount target. The spawned child's HOME (ENV HOME below) is
# /home/agentuser so `pi` resolves the same mounted auth.json the terminal
# client does; the compose `user:` override aligns the process uid with the
# host so it can traverse the host-owned 0700 config dir. World-traversable
# (0755) so a numeric-uid override can still reach it.
RUN mkdir -p /home/agentuser/.config \
 && chmod 755 /home/agentuser /home/agentuser/.config

WORKDIR /app
# The server binary and the hash file HASHED-asset lookups read from next to the
# binary (HashedStylesheet/HydrationScripts). cargo-leptos writes the server
# artifacts to the `bin-target-dir` declared in Cargo.toml, i.e.
# target/server/release — not the default cargo target.
COPY --from=builder /build/target/server/release/cheasee-pi-ui /app/cheasee-pi-ui
COPY --from=builder /build/target/server/release/hash.txt /app/hash.txt
# /target/site holds the content-hashed JS/WASM/CSS; `site-root = "target/site"`
# in Cargo.toml is unaffected by the server target dir above.
COPY --from=builder /build/target/site /app/site
RUN chown -R ui:ui /app

# Point Leptos at the copied artifacts. LEPTOS_HASH_FILES must be true or the
# server asks for unhashed filenames that do not exist in the image.
ENV LEPTOS_SITE_ROOT=/app/site \
    LEPTOS_SITE_PKG_DIR=assets \
    LEPTOS_OUTPUT_NAME=cheasee-pi-ui \
    LEPTOS_HASH_FILES=true \
    LEPTOS_ENV=PROD \
    HOME=/home/agentuser

USER ui
EXPOSE 3000
CMD ["/app/cheasee-pi-ui"]
