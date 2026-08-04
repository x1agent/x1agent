#!/bin/sh
set -eu

runtime="${X1_RUNTIME:-claude_code}"

case "$runtime" in
  claude_code)
    # Local-dev login profiles are projected read-only at a separate path.
    # Claude Code refreshes OAuth credentials during long sessions, so seed a
    # private writable copy rather than mounting the host credential in place.
    if [ -n "${CLAUDE_AUTH_SOURCE:-}" ] && [ -f "$CLAUDE_AUTH_SOURCE" ]; then
      claude_config_dir="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
      mkdir -p "$claude_config_dir"
      cp "$CLAUDE_AUTH_SOURCE" "$claude_config_dir/.credentials.json"
      chmod 600 "$claude_config_dir/.credentials.json"
    fi
    exec /x1/runtime/bin/node \
      /x1/runtime/lib/node_modules/tsx/dist/cli.mjs \
      /x1/app/packages/agent-claude/src/run.ts "$@"
    ;;
  codex)
    # Codex accepts CODEX_API_KEY; keep OPENAI_API_KEY as the platform
    # contract and alias it only inside the selected runtime.
    if [ -z "${CODEX_API_KEY:-}" ] && [ -n "${OPENAI_API_KEY:-}" ]; then
      export CODEX_API_KEY="$OPENAI_API_KEY"
    fi
    if [ -n "${CODEX_AUTH_SOURCE:-}" ] && [ -f "$CODEX_AUTH_SOURCE" ]; then
      mkdir -p "${CODEX_HOME:-/home/agent/.codex}"
      cp "$CODEX_AUTH_SOURCE" "${CODEX_HOME:-/home/agent/.codex}/auth.json"
      chmod 600 "${CODEX_HOME:-/home/agent/.codex}/auth.json"
    fi
    exec /x1/runtime/bin/node \
      /x1/runtime/lib/node_modules/tsx/dist/cli.mjs \
      /x1/app/packages/agent-codex/src/run.ts "$@"
    ;;
  *)
    echo "unsupported X1_RUNTIME: $runtime" >&2
    exit 64
    ;;
esac
