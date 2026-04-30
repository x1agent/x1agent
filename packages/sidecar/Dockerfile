# x1agent sidecar — Rust, bridges the agent container to NATS + api.
# No TLS material baked into the image; NATS credentials and API
# internal tokens flow in via env.

FROM rust:1-alpine AS builder

RUN apk add --no-cache musl-dev pkgconf git openssl-dev openssl-libs-static

WORKDIR /build
COPY Cargo.toml ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src target/release/deps/x1agent_sidecar*
COPY src/ ./src/
RUN cargo build --release

FROM alpine:3.20

RUN apk add --no-cache ca-certificates git openssh-client \
 && addgroup -g 1000 sidecar \
 && adduser -D -u 1000 -G sidecar sidecar

COPY --from=builder /build/target/release/x1agent-sidecar /usr/local/bin/x1agent-sidecar

# The sidecar runs as uid 1000 so files it writes into /workspace
# (notably: git-cloned repos) are owned by the same uid the agent
# container runs under, and the agent can write to them directly.
# Running as root caused a perm bug where cloned repos were root-owned
# mode 0755 and the agent (uid 1000) could read but not write — the
# chown-to-1000 attempt silently failed because CAP_CHOWN had been
# dropped by the Pod security context. Running as the target uid
# from the start side-steps all of that.
USER sidecar

ENTRYPOINT ["/usr/local/bin/x1agent-sidecar"]
