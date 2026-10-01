# Cheasee-Pi web control center — Axum server + Leptos hydrate shell.
# Multi-stage: a rust builder produces the server binary and the content-hashed
# wasm/CSS bundle via cargo-leptos; the slim runtime serves both.
#
# Toolchain floor is the leptos 0.8 MSRV (1.88) — bump this only together with
# the leptos line in Cargo.toml.
FROM rust:1.88-bookworm AS builder

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
# The server binary; the hash file HASHED-asset lookups read from next to the
# binary (HashedStylesheet/HydrationScripts); and the site dir `/assets/*` serves.
COPY --from=builder /build/target/release/cheasee-pi-ui /app/cheasee-pi-ui
COPY --from=builder /build/target/release/hash.txt /app/hash.txt
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
