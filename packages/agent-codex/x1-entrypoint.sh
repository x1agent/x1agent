#!/bin/sh
# x1agent Codex runtime entrypoint. Drives `codex app-server --stdio`
# and translates its JSON-RPC event stream into platform wire events.
#
# Codex CLI honors both CODEX_API_KEY and OPENAI_API_KEY; we alias the
# latter to the former here so the existing platform-wide OPENAI_API_KEY
# secret reaches the CLI without a second env var on the pod.
if [ -z "${CODEX_API_KEY:-}" ] && [ -n "${OPENAI_API_KEY:-}" ]; then
  export CODEX_API_KEY="$OPENAI_API_KEY"
fi

# Dev login profiles are projected read-only at a separate path so a session
# can never overwrite the host's config.toml or auth cache. Codex needs a
# writable auth.json to refresh expiring credentials, so seed a private copy.
if [ -n "${CODEX_AUTH_SOURCE:-}" ] && [ -f "$CODEX_AUTH_SOURCE" ]; then
  mkdir -p "${CODEX_HOME:-/home/agent/.codex}"
  cp "$CODEX_AUTH_SOURCE" "${CODEX_HOME:-/home/agent/.codex}/auth.json"
  chmod 600 "${CODEX_HOME:-/home/agent/.codex}/auth.json"
fi

exec /x1/runtime/bin/node \
  /x1/runtime/lib/node_modules/tsx/dist/cli.mjs \
  /x1/app/src/run.ts "$@"
