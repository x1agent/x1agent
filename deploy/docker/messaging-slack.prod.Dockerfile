# Production image for @x1agent/provider-messaging-slack. Multi-stage,
# same shape as graph-surrealdb.prod.Dockerfile. Provider speaks NATS
# (no HTTP port to expose); liveness comes from the NATS connection.
FROM oven/bun:1.2.16-alpine AS deps

RUN apk add --no-cache bash
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY --parents packages/**/package.json packages/**/tsconfig.json ./
COPY --parents docs/package.json docs/tsconfig.json ./

RUN bun install --frozen-lockfile --ignore-scripts

# ── runtime ───────────────────────────────────────────────────────────
FROM oven/bun:1.2.16-alpine AS runtime

RUN apk add --no-cache bash tini ca-certificates && \
    (deluser bun 2>/dev/null || true) && \
    (delgroup bun 2>/dev/null || true) && \
    addgroup -g 1000 agent && \
    adduser  -u 1000 -G agent -s /bin/bash -D -h /home/agent agent

WORKDIR /app

COPY --from=deps --chown=agent:agent /app/node_modules ./node_modules
COPY --from=deps --chown=agent:agent /app/package.json /app/bun.lock /app/tsconfig.base.json ./
COPY --chown=agent:agent packages/kernel/ ./packages/kernel/
COPY --chown=agent:agent packages/shared/ ./packages/shared/
COPY --chown=agent:agent packages/observability/ ./packages/observability/
COPY --chown=agent:agent packages/providers/messaging-slack/ ./packages/providers/messaging-slack/

USER agent
ENV NODE_ENV=production

ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "--cwd", "packages/providers/messaging-slack", "src/index.ts"]
