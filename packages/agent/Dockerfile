# x1agent session runtime — "runtime-core".
#
# This image plays two roles:
#
# 1. A buildable, runnable reference. You can `FROM x1agent/runtime-core`
#    and add a language toolchain. Simple, but it forces every preset
#    to start from node-slim rather than the language's canonical image
#    (golang:1.24, python:3.13-slim, rust:1.95-slim, ...). That pattern
#    works but is not idiomatic Docker.
#
# 2. A SOURCE OF FILES to `COPY --from=`. The real pattern — and the
#    one all shipped presets use — is:
#
#        FROM python:3.13-slim-bookworm
#        COPY --from=x1agent/runtime-core:v1 /x1 /x1
#        ENV PATH="/x1/bin:${PATH}"
#        ENTRYPOINT ["/x1/bin/entrypoint"]
#
#    Everything the agent runtime needs is bundled under `/x1/`:
#      /x1/bin/entrypoint         launcher script
#      /x1/bin/gh                 gh CLI (on PATH via `ENV PATH`)
#      /x1/bin/git-credential-x1  sidecar credential shim
#      /x1/app/                   agent SDK (src + node_modules)
#      /x1/runtime/               bundled Node 22 (bin + lib/node_modules)
#      /x1/etc/gitconfig          git config to link to /etc/gitconfig
#
#    The preset adds a uid 1000 user (most language images don't have
#    one), links gitconfig, and delegates to the entrypoint. See
#    docs/architecture/runtime-images.md for the full rationale.
#
# Constraint: the bundled Node links against glibc. Presets must use
# glibc-based bases (debian bookworm) for v1. An alpine/musl variant
# is future work when someone asks.

FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# gh CLI — released separately from the node base image.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code tsx

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY src/ ./src/
COPY tsconfig.json ./

# ── Runtime stage ─────────────────────────────────────────
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/bin/gh /usr/bin/gh
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin/ /usr/local/bin/

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/package.json ./

COPY git-credential-x1.sh /usr/local/bin/git-credential-x1
RUN chmod +x /usr/local/bin/git-credential-x1
COPY gitconfig /etc/gitconfig

RUN mkdir -p /workspace && chmod 777 /workspace

# ── Build the /x1 overlay tree ─────────────────────────────
# Language presets COPY this entire directory as their only hard
# dependency on runtime-core. Everything in /x1 is self-contained and
# PATH-independent — the entrypoint uses absolute paths into /x1.
RUN set -e \
  && mkdir -p /x1/bin /x1/app /x1/runtime/bin /x1/runtime/lib /x1/etc \
  && cp -L /usr/local/bin/node /x1/runtime/bin/node \
  && cp -rL /usr/local/lib/node_modules /x1/runtime/lib/node_modules \
  && cp -r /app/. /x1/app/ \
  && cp /usr/bin/gh /x1/bin/gh \
  && cp /usr/local/bin/git-credential-x1 /x1/bin/git-credential-x1 \
  && cp /etc/gitconfig /x1/etc/gitconfig

# Entrypoint script: run the Agent SDK launcher under the bundled
# Node + tsx. Works regardless of whether the base image ships its
# own Node — we ignore $PATH and use absolute paths.
COPY x1-entrypoint.sh /x1/bin/entrypoint
RUN chmod +x /x1/bin/entrypoint

# Claude Code refuses --dangerously-skip-permissions as root. The
# node:22-slim base image ships a `node` user at uid 1000; we reuse
# it. When used via COPY --from overlay, the preset ensures its own
# uid 1000 exists.
RUN mkdir -p /home/node/.claude \
  && chown -R node:node /app /workspace /home/node /x1
USER node
ENV HOME=/home/node

LABEL org.x1agent.image="runtime-core" \
      org.x1agent.image.role="base-and-overlay-source"

WORKDIR /workspace

ENTRYPOINT ["/x1/bin/entrypoint"]
