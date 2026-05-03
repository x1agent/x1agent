# mcp-oauth-proxy — sibling container that holds a per-user OAuth
# bearer for one remote_oauth MCP attachment and forwards the agent's
# requests to the upstream MCP URL with Authorization injected.
#
# See packages/mcp-oauth-proxy/src/index.ts for the threat model.
#
# Build context is the monorepo root; we only need bun + the proxy
# source. No workspace deps to resolve (the proxy uses node stdlib
# + bun's built-in fetch/serve). Tiny image, fast startup.

FROM oven/bun:1.2-alpine
WORKDIR /app

COPY packages/mcp-oauth-proxy/src /app/src
COPY packages/mcp-oauth-proxy/package.json /app/package.json

USER 1000

CMD ["bun", "run", "src/index.ts"]
