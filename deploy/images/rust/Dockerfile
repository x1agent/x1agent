# x1agent preset: Rust stable
#
# Rust doesn't define LTS — `stable` is the supported channel and every
# six weeks a new minor replaces it. This preset installs rustup with
# the minimal profile and the stable toolchain; admins who need a
# specific version can override with `rustup default <version>` inside
# the agent's workspace or fork this Dockerfile.
#
# build-essential + pkg-config + libssl-dev cover the common crate
# dependencies (tokio, reqwest, etc.) that link against openssl.

ARG BASE_IMAGE=x1agent/runtime-core:v1
FROM ${BASE_IMAGE}

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      pkg-config \
      libssl-dev \
      ripgrep \
      jq \
  && rm -rf /var/lib/apt/lists/*

USER node

ENV CARGO_HOME=/home/node/.cargo
ENV RUSTUP_HOME=/home/node/.rustup
ENV PATH="/home/node/.cargo/bin:${PATH}"

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
      sh -s -- -y \
        --default-toolchain stable \
        --profile minimal \
        --no-modify-path \
  && rustc --version \
  && cargo --version \
  && rustup component add clippy rustfmt
