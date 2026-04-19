# x1agent sidecar — Rust, bridges the agent container to NATS + api.
# No TLS material baked into the image; NATS credentials and API
# internal tokens flow in via env.

FROM rust:1-alpine AS builder

RUN apk add --no-cache musl-dev pkgconf git

WORKDIR /build
COPY Cargo.toml ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src target/release/deps/x1agent_sidecar*
COPY src/ ./src/
RUN cargo build --release

FROM alpine:3.20

RUN apk add --no-cache ca-certificates git openssh-client

COPY --from=builder /build/target/release/x1agent-sidecar /usr/local/bin/x1agent-sidecar

ENTRYPOINT ["/usr/local/bin/x1agent-sidecar"]
