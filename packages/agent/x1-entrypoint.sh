#!/bin/sh
# x1agent session entrypoint. Runs the Claude Agent SDK launcher under
# the bundled Node + tsx. Uses absolute paths into /x1 so it works in
# any base image that has the overlay copied in — the base doesn't need
# Node on $PATH.
exec /x1/runtime/bin/node \
  /x1/runtime/lib/node_modules/tsx/dist/cli.mjs \
  /x1/app/src/run.ts "$@"
