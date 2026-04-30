# x1agent preset: Node.js 22 LTS
#
# Starts from Node's canonical slim image (bookworm, Active LTS "Jod")
# and layers the x1 agent overlay on top. node:22-bookworm-slim already
# ships a `node` user at uid 1000, which we rename to `agent` with home
# /home/agent so every runtime image follows the same convention —
# pod-spec hostPath-mounts /home/agent/.claude/.credentials.json at dev
# time, and the agent's $HOME must resolve to that path or Claude Code
# auth breaks silently.
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
# Rename the base image's `node` user (uid 1000) to `agent` and
# relocate its home to /home/agent. `usermod -m` moves the existing
# home contents so any files node:22 put there (e.g. npm cache) stay
# accessible.
RUN usermod -l agent -d /home/agent -m node \
  && groupmod -n agent node \
  && ln -sf /x1/etc/gitconfig /etc/gitconfig \
  && mkdir -p /workspace \
  && chown -R 1000:1000 /x1 /workspace /home/agent

USER 1000
ENV HOME=/home/agent
ENV PATH="/x1/bin:${PATH}"
WORKDIR /workspace

ENTRYPOINT ["/x1/bin/entrypoint"]
