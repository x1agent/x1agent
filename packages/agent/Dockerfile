# x1agent session runtime — Claude Agent SDK + gh CLI + git, with a
# credential helper that shells to the sidecar. No secrets live in this
# image; every request is minted on demand by the sidecar.

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

RUN mkdir -p /workspace
WORKDIR /workspace

ENTRYPOINT ["tsx", "/app/src/run.ts"]
