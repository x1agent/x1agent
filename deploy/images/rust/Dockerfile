# x1agent preset: Rust stable
#
# Starts from Rust's canonical image (bookworm; rustup-managed
# toolchain, cargo, rustc preconfigured) and layers the x1 agent
# overlay on top. Rust has no LTS; the image tracks the current stable
# minor and rebuilds pull the latest.

ARG AGENT_OVERLAY=x1agent/runtime-core:v1
FROM ${AGENT_OVERLAY} AS x1

FROM rust:1-bookworm

# --- x1 agent overlay ---
COPY --from=x1 /x1 /x1

# --- language-agnostic dev tooling + common native-link deps ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config \
      libssl-dev \
      ripgrep \
      jq \
  && rm -rf /var/lib/apt/lists/*

# --- rustup components the agent is likely to reach for ---
RUN rustup component add clippy rustfmt

# --- user + workspace + entrypoint wiring ---
# rust:1-bookworm runs as root. Create uid 1000 and rewire CARGO_HOME
# to the agent's home so `cargo install` writes to a path the agent
# owns.
RUN id -u 1000 >/dev/null 2>&1 \
    || ( groupadd --system --gid 1000 agent \
      && useradd --system --uid 1000 --gid 1000 --home /home/agent \
           --create-home --shell /bin/bash agent ) \
  && ln -sf /x1/etc/gitconfig /etc/gitconfig \
  && mkdir -p /workspace /home/agent/.cargo \
  && chown -R 1000:1000 /x1 /workspace /home/agent

USER 1000
ENV HOME=/home/agent
ENV CARGO_HOME=/home/agent/.cargo
ENV PATH="/x1/bin:${CARGO_HOME}/bin:${PATH}"
WORKDIR /workspace

ENTRYPOINT ["/x1/bin/entrypoint"]
