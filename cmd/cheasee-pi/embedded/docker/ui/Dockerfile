# Cheasee-Pi web control center — placeholder Axum server (GET / → 200).
# Multi-stage: a rust builder compiles the static binary, the slim runtime
# stage keeps the shipped image tiny.
# ponytail: toolchain pinned to the first release that parses the current
# lock's manifests (hyper-util 0.1.21 is edition 2024, needs cargo >= 1.85);
# bump this when a future `cargo build` fails on "failed to parse manifest".
FROM rust:1.85-bookworm AS builder

WORKDIR /build

# Dependency layer: build a throwaway main against the manifest so the heavy
# dependency graph compiles once and stays cached across source-only changes.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && \
    cargo build --release && \
    rm -rf src

# Real sources — touch forces the final bin to relink.
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim

COPY --from=builder /build/target/release/cheasee-pi-ui /usr/local/bin/cheasee-pi-ui

EXPOSE 3000

CMD ["/usr/local/bin/cheasee-pi-ui"]
