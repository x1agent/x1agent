# x1agent preset: Python 3.13
#
# Starts from Python's canonical slim image (bookworm) — the same base
# most Python projects use — and layers the x1 agent runtime on top as
# a drop-in `/x1/` overlay copied from `x1agent/runtime-core`.
#
# See docs/architecture/runtime-images.md for why the overlay pattern
# inverts `FROM runtime-core`. Short version: devs author Dockerfiles
# against their language's official image (Python's team maintains
# python:3.13-slim-bookworm), and the agent runtime rides along as an
# opaque copied-in tree.

ARG AGENT_OVERLAY=x1agent/runtime-core:v1
FROM ${AGENT_OVERLAY} AS x1

FROM python:3.13-slim-bookworm

# --- x1 agent overlay ---
COPY --from=x1 /x1 /x1

# --- language-agnostic dev tooling ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      ripgrep \
      jq \
      build-essential \
  && rm -rf /var/lib/apt/lists/*

# --- uv: fast Python installer + package manager ---
RUN curl -LsSf https://astral.sh/uv/install.sh | \
      env UV_INSTALL_DIR=/usr/local/bin sh

# --- user + workspace + entrypoint wiring ---
# python:3.13-slim-bookworm runs as root. Create the uid 1000 user the
# overlay expects, link gitconfig so git + gh see it, hand workspace
# ownership over to the agent.
RUN id -u 1000 >/dev/null 2>&1 \
    || ( groupadd --system --gid 1000 agent \
      && useradd --system --uid 1000 --gid 1000 --home /home/agent \
           --create-home --shell /bin/bash agent ) \
  && ln -sf /x1/etc/gitconfig /etc/gitconfig \
  && mkdir -p /workspace \
  && chown -R 1000:1000 /x1 /workspace

USER 1000
ENV HOME=/home/agent
# /x1/bin provides gh + git-credential-x1 to PATH.
ENV PATH="/x1/bin:${PATH}"
WORKDIR /workspace

ENTRYPOINT ["/x1/bin/entrypoint"]
