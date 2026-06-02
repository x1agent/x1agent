#!/bin/sh
# x1agent Codex runtime entrypoint. Spike v0: spawns `codex exec --json`
# as a subprocess and translates its JSONL event stream into the
# platform's wire events. See packages/agent-codex/README.md.
#
# Codex CLI honors both CODEX_API_KEY and OPENAI_API_KEY; we alias the
# latter to the former here so the existing platform-wide OPENAI_API_KEY
# secret reaches the CLI without a second env var on the pod.
if [ -z "${CODEX_API_KEY:-}" ] && [ -n "${OPENAI_API_KEY:-}" ]; then
  export CODEX_API_KEY="$OPENAI_API_KEY"
fi

exec /x1/runtime/bin/node \
  /x1/runtime/lib/node_modules/tsx/dist/cli.mjs \
  /x1/app/src/run.ts "$@"
