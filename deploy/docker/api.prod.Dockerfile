# syntax=docker/dockerfile:1.7-labs
# Production image for @x1agent/api. Multi-stage:
#   1. deps   — install workspace deps from frozen lockfile
#   2. runtime — copy deps + source, set ENTRYPOINT
#
# Differences from api.dev.Dockerfile:
#   - Pinned bun version (matches mise.toml host version)
#   - --frozen-lockfile (build fails if lockfile drifted, surfaces in CI)
#   - No deploy/migrations sync mount — migrations are baked in
#   - Non-root user from the start (matches the agent-user convention)
#   - Skips packages that aren't reachable from the api at runtime
#     (cli, app, providers/messaging-slack/graph-surrealdb/preview);
#     they're still copied as workspace manifests for `bun install` to
#     resolve symlinks but their `src/` isn't shipped.
#
# Tag scheme: <registry>/x1agent/api:<git-sha> + :<semver>. The installer
# builds + pushes, then helm upgrade --install with the rendered tag.
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

# Bring deps + the ONLY package src this image runs at runtime.
COPY --from=deps --chown=agent:agent /app/node_modules ./node_modules
COPY --from=deps --chown=agent:agent /app/package.json /app/bun.lock /app/tsconfig.base.json ./
COPY --chown=agent:agent packages/kernel/ ./packages/kernel/
COPY --chown=agent:agent packages/shared/ ./packages/shared/
COPY --chown=agent:agent packages/observability/ ./packages/observability/
COPY --chown=agent:agent packages/api/ ./packages/api/
COPY --chown=agent:agent packages/domains/ ./packages/domains/
COPY --chown=agent:agent deploy/migrations/ ./deploy/migrations/
COPY --chown=agent:agent deploy/images/ ./deploy/images/
COPY --chown=agent:agent packages/agent/Dockerfile ./deploy/images/runtime-core/Dockerfile

USER agent
EXPOSE 30001
ENV NODE_ENV=production API_PORT=30001

ENTRYPOINT ["tini", "--"]
# api just starts. Migrations are the chart's post-install migrate Job's
# job (templates/migrate-job.yaml) — running them here too races that
# Job and breaks fresh installs (two parallel migrators commit
# different rows, second one trips on already-created types). The
# migrate Job's hook ordering guarantees migrations land before the
# helm release reports success, so by the time external traffic hits
# the api the schema is current.
CMD ["sh", "-c", "cd packages/api && exec bun run src/index.ts"]
