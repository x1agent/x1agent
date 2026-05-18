#!/bin/sh
# gh CLI wrapper — fetches a fresh GitHub App installation token from the
# sidecar on localhost:9090 per invocation, exports it as GH_TOKEN, then
# execs the real gh binary. Sibling of git-credential-x1: same sidecar
# endpoint, same "no long-lived token in agent memory" model, adapted to
# gh's auth surface (env var, since gh has no credential.helper hook).
#
# See docs/security/credential-proxy.md.

# Resolve the real gh binary.
#   /x1/libexec/gh-real — preset images bundle it under the /x1 overlay
#   /usr/bin/gh         — runtime-core direct use installs gh here
if [ -x /x1/libexec/gh-real ]; then
  REAL_GH=/x1/libexec/gh-real
elif [ -x /usr/bin/gh ]; then
  REAL_GH=/usr/bin/gh
else
  echo "gh-x1: real gh binary not found at /x1/libexec/gh-real or /usr/bin/gh" >&2
  exit 127
fi

# Sidecar returns JSON: {"token":"ghs_..."} for ?format=token.
# Parse with sed (same approach as git-credential-x1.sh) to avoid a jq dep.
resp=$(curl -sf "http://localhost:9090/git/credential?format=token" 2>/dev/null)
token=$(echo "$resp" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -n "$token" ]; then
  export GH_TOKEN="$token"
fi

exec "$REAL_GH" "$@"
