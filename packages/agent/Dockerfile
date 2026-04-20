# x1agent session runtime — the "runtime-core" base image. Ships the
# agent SDK, gh CLI, git, the git-credential-x1 shim, and a non-root
# user at uid 1000. No language toolchains (python, go, rust, ...) —
# those are layered on in admin-authored preset images via
# `FROM x1agent/runtime-core:<version>`.
#
# See docs/architecture/runtime-images.md for the FROM-pattern
# contract and the reject-list (USER 0, privileged ports, baked
# secrets). No secrets live in this image; every credential-bearing
# request is minted on demand by the sidecar.

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

# Claude Code refuses --dangerously-skip-permissions as root. The
# node:22-slim base image already ships a `node` user at uid 1000; we
# reuse it and give them a home dir so Claude Code writes settings and
# debug logs somewhere writable. Preset images that FROM runtime-core
# inherit this user; they must END with `USER node`, which the
# runtime-images.md save-time validator enforces.
RUN mkdir -p /home/node/.claude \
  && chown -R node:node /app /workspace /home/node
USER node
ENV HOME=/home/node

# Platform-tagged labels so the image is identifiable in any registry
# that holds it. Preset images override these with their own name.
LABEL org.x1agent.image="runtime-core" \
      org.x1agent.image.role="base"

WORKDIR /workspace

ENTRYPOINT ["tsx", "/app/src/run.ts"]
