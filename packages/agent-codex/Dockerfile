# x1agent Codex session runtime — spike v0.
#
# Parallel to packages/agent/Dockerfile (the Claude Code runtime). Same
# overall shape: a multi-stage build that ends up with a /x1/ overlay
# tree containing the bundled Node runtime, the harness source, and an
# entrypoint that execs them. The only meaningful differences vs the
# Claude image are:
#
#   1. Installs `@openai/codex` globally instead of `@anthropic-ai/claude-code`
#      so the agent loop driver is the Codex CLI rather than the Claude SDK.
#   2. The /x1/app/ overlay points at packages/agent-codex/src/ which spawns
#      `codex exec --json` and translates Codex JSONL → platform events.
#
# This is a SPIKE image. The /x1/ overlay scaffolding (gh shim, git
# credential shim, uid 1000 agent user, gitconfig) is duplicated from
# packages/agent/Dockerfile rather than COPY --from'd from runtime-core
# because the spike worker isn't trying to refactor the overlay-source
# story right now. The follow-up to this spike (X1A-?? — TBD) extracts
# the overlay into packages/runtime-core/ and has both runtime images
# COPY --from it.

FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Codex CLI + tsx. Codex publishes a Node-wrapper bin (`codex`) that
# shells out to a bundled Rust core; npm-installing it globally is the
# documented headless install path.
RUN npm install -g @openai/codex tsx

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

# Reuse the agent runtime's shim scripts and gitconfig. The spike copies
# them in directly rather than reaching into ../agent/ because Docker's
# build context is per-package; once the runtime-core package lands we
# move these to a single source of truth.
COPY git-credential-x1.sh /usr/local/bin/git-credential-x1
RUN chmod +x /usr/local/bin/git-credential-x1
COPY gh-x1.sh /usr/local/bin/gh
RUN chmod +x /usr/local/bin/gh
COPY gitconfig /etc/gitconfig

RUN mkdir -p /workspace && chmod 777 /workspace

# ── Build the /x1 overlay tree ─────────────────────────────
RUN set -e \
  && mkdir -p /x1/bin /x1/libexec /x1/app /x1/runtime/bin /x1/runtime/lib /x1/etc \
  && cp -L /usr/local/bin/node /x1/runtime/bin/node \
  && cp -rL /usr/local/lib/node_modules /x1/runtime/lib/node_modules \
  && cp -r /app/. /x1/app/ \
  && cp /usr/bin/gh /x1/libexec/gh-real \
  && cp /usr/local/bin/gh /x1/bin/gh \
  && cp /usr/local/bin/git-credential-x1 /x1/bin/git-credential-x1 \
  && cp /etc/gitconfig /x1/etc/gitconfig

COPY x1-entrypoint.sh /x1/bin/entrypoint
RUN chmod +x /x1/bin/entrypoint

# uid 1000 `agent` user — same identity convention as runtime-claude.
RUN userdel -f node 2>/dev/null || true \
  && groupadd --system --gid 1000 agent \
  && useradd --system --uid 1000 --gid 1000 --home /home/agent \
       --create-home --shell /bin/bash agent \
  && mkdir -p /home/agent/.codex \
  && chown -R agent:agent /app /workspace /home/agent /x1
USER agent
ENV HOME=/home/agent

LABEL org.x1agent.image="runtime-codex" \
      org.x1agent.image.role="agent-runtime" \
      org.x1agent.runtime="codex"

WORKDIR /workspace

ENTRYPOINT ["/x1/bin/entrypoint"]
