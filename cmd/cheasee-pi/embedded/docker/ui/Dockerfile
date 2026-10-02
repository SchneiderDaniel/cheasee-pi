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
# PATH: `wasm-opt` (binaryen) and a `wasm-bindgen` CLI. Installing binaryen
# keeps `docker build` off GitHub-release downloads.
RUN rustup target add wasm32-unknown-unknown \
 && apt-get update \
 && apt-get install -y --no-install-recommends binaryen \
 && rm -rf /var/lib/apt/lists/*

# Pin cargo-leptos, and read the wasm-bindgen CLI version straight from the
# committed lock so the CLI can never drift from the wasm-bindgen crate it runs.
COPY Cargo.toml Cargo.lock ./
RUN WB="$(sed -n '/^name = "wasm-bindgen"$/{n;s/^version = "\(.*\)"$/\1/p;}' Cargo.lock)" \
 && test -n "$WB" \
 && cargo install wasm-bindgen-cli --version "$WB" --locked \
 && cargo install cargo-leptos --version 0.3.10 --locked --no-default-features --features no_downloads

COPY src ./src
COPY style ./style
# cargo-leptos builds the wasm lib (feature `hydrate`) and the server bin
# (feature `ssr`) per [package.metadata.leptos], then hashes the asset names.
RUN cargo leptos build --release

FROM debian:bookworm-slim

# curl is the compose healthcheck probe; the slim base image ships no HTTP
# client, and curl is what the healthcheck and the human validation call.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

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

# Point Leptos at the copied artifacts. LEPTOS_HASH_FILES must be true or the
# server asks for unhashed filenames that do not exist in the image.
ENV LEPTOS_SITE_ROOT=/app/site \
    LEPTOS_SITE_PKG_DIR=assets \
    LEPTOS_OUTPUT_NAME=cheasee-pi-ui \
    LEPTOS_HASH_FILES=true \
    LEPTOS_ENV=PROD

EXPOSE 3000
CMD ["/app/cheasee-pi-ui"]
