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
#      /x1/bin/gh                 gh CLI shim (mints fresh token per call, execs gh-real)
#      /x1/bin/git-credential-x1  sidecar credential shim
#      /x1/libexec/gh-real        real gh CLI binary (called by /x1/bin/gh shim)
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
COPY packages/agent-claude/package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY packages/agent-claude/src/ ./packages/agent-claude/src/
COPY packages/agent-runtime/src/ ./packages/agent-runtime/src/

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
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./

COPY packages/agent-runtime/assets/git-credential-x1.sh /usr/local/bin/git-credential-x1
RUN chmod +x /usr/local/bin/git-credential-x1
# gh CLI shim — intercepts /usr/bin/gh by sitting earlier on PATH.
# Mints a fresh installation token from the sidecar on every invocation.
COPY packages/agent-runtime/assets/gh-x1.sh /usr/local/bin/gh
RUN chmod +x /usr/local/bin/gh
COPY packages/agent-runtime/assets/gitconfig /etc/gitconfig

RUN mkdir -p /workspace && chmod 777 /workspace

# ── Build the /x1 overlay tree ─────────────────────────────
# Language presets COPY this entire directory as their only hard
# dependency on runtime-core. Everything in /x1 is self-contained and
# PATH-independent — the entrypoint uses absolute paths into /x1.
RUN set -e \
  && mkdir -p /x1/bin /x1/libexec /x1/app /x1/runtime/bin /x1/runtime/lib /x1/etc \
  && cp -L /usr/local/bin/node /x1/runtime/bin/node \
  && cp -rL /usr/local/lib/node_modules /x1/runtime/lib/node_modules \
  && cp -r /app/. /x1/app/ \
  && cp /usr/bin/gh /x1/libexec/gh-real \
  && cp /usr/local/bin/gh /x1/bin/gh \
  && cp /usr/local/bin/git-credential-x1 /x1/bin/git-credential-x1 \
  && cp /etc/gitconfig /x1/etc/gitconfig

# Entrypoint script: run the Agent SDK launcher under the bundled
# Node + tsx. Works regardless of whether the base image ships its
# own Node — we ignore $PATH and use absolute paths.
COPY packages/agent-claude/x1-entrypoint.sh /x1/bin/entrypoint
RUN chmod +x /x1/bin/entrypoint

# Every x1agent runtime image — this one plus every preset that
# COPY --from's the /x1 overlay — provides a uid 1000 user named
# `agent` with a home at /home/agent. The name is deliberate:
# `agent` is runtime-agnostic (Claude Code today, Codex / opencode /
# Gemini tomorrow), decoupled from the base image's default user
# (node:22-slim's `node`, python:slim's root, etc.), and carries the
# semantic that this identity IS the agent's execution context —
# not "a JavaScript runtime user who happens to be us."
#
# Claude Code's refusal to run as root with --dangerously-skip-
# permissions forces uid > 0; we pick 1000 because it's the POSIX
# convention for the first regular user, it matches what node:slim
# and most language-tooling images expose, and it lines up with the
# fsGroup the pod spec sets on shared volumes.
#
# node:22-slim's built-in `node` user is removed so the image has
# exactly one uid 1000 identity and that identity is unambiguously
# the agent. This avoids a class of bugs where mounts owned by
# "node" leak into agent-writable paths and vice versa.
RUN userdel -f node 2>/dev/null || true \
  && groupadd --system --gid 1000 agent \
  && useradd --system --uid 1000 --gid 1000 --home /home/agent \
       --create-home --shell /bin/bash agent \
  && mkdir -p /home/agent/.claude \
  && chown -R agent:agent /app /workspace /home/agent /x1
USER agent
ENV HOME=/home/agent

LABEL org.x1agent.image="runtime-core" \
      org.x1agent.image.role="base-and-overlay-source"

WORKDIR /workspace

ENTRYPOINT ["/x1/bin/entrypoint"]
