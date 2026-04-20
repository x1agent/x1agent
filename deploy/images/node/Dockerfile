# x1agent preset: Node.js 22 LTS
#
# Starts from Node's canonical slim image (bookworm, Active LTS "Jod")
# and layers the x1 agent overlay on top. node:22-bookworm-slim already
# ships a `node` user at uid 1000 which matches what the overlay
# expects, so the user-setup is trivial here.
#
# Adds TypeScript and pnpm on top since most TS codebases assume they
# are globally available.

ARG AGENT_OVERLAY=x1agent/runtime-core:v1
FROM ${AGENT_OVERLAY} AS x1

FROM node:22-bookworm-slim

# --- x1 agent overlay ---
COPY --from=x1 /x1 /x1

# --- language-agnostic dev tooling + globals ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      ripgrep \
      jq \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g typescript@5 pnpm@9

# --- user + workspace + entrypoint wiring ---
# node:22-bookworm-slim already has a `node` user at uid 1000.
RUN ln -sf /x1/etc/gitconfig /etc/gitconfig \
  && mkdir -p /workspace \
  && chown -R 1000:1000 /x1 /workspace

USER node
ENV HOME=/home/node
ENV PATH="/x1/bin:${PATH}"
WORKDIR /workspace

ENTRYPOINT ["/x1/bin/entrypoint"]
