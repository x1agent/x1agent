# Dev image for the mcp-oauth-proxy sibling container.
#
# The proxy has no workspace dependencies (uses node stdlib + bun's
# built-in fetch/serve), so the dev image mirrors the prod shape: a
# bun base, the proxy source copied in. No file-sync — the proxy is
# stateless and rarely changes; rebuilding is fast.
#
# See packages/mcp-oauth-proxy/src/index.ts for the threat model.

FROM oven/bun:1.2.16-alpine
WORKDIR /app

COPY packages/mcp-oauth-proxy/src /app/src
COPY packages/mcp-oauth-proxy/package.json /app/package.json

USER 1000

CMD ["bun", "run", "src/index.ts"]
