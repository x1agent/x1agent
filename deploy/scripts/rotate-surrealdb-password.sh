#!/usr/bin/env bash
# Rotate the SurrealDB root password for the active deployment.
#
# What it does (idempotent):
#   1. Picks the active install file under installs/<basedomain>.local
#      (X1AGENT_DEPLOYMENT env var wins; otherwise the single non-example
#      file). Same selection rule as every other prod task.
#   2. Generates a fresh 32-byte hex password.
#   3. Writes (or replaces) `SURREALDB_ROOT_PASSWORD=<value>` in that file.
#   4. Runs `mise run install:plan` so the deployment-specific
#      values.<basedomain>.yaml is regenerated with the new password.
#
# After it finishes, run `mise run deploy:prod` to roll the SurrealDB
# StatefulSet + provider deployment with the new env value. The script
# does not deploy on its own — it does not assume you want to push to
# the cluster the same minute you generate the password.
#
# IMPORTANT: this is a destructive rotation. After the next pod roll,
# the OLD password no longer authenticates to SurrealDB. Don't run it
# in the middle of a release if you have other connectors using the
# old credential.

set -euo pipefail

INSTALLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../installs" && pwd)"

# Pick the active install file — same selection rule as deploy/scripts/psql-prod.sh.
if [[ -n "${X1AGENT_DEPLOYMENT:-}" ]]; then
  ENV_FILE="$INSTALLS_DIR/${X1AGENT_DEPLOYMENT}.local"
else
  CANDIDATES=("$INSTALLS_DIR"/*.local)
  ACTIVE=""
  for c in "${CANDIDATES[@]}"; do
    base="$(basename "$c")"
    [[ "$base" == "example.local" ]] && continue
    if [[ -n "$ACTIVE" ]]; then
      echo "[rotate-surreal] multiple deployments under installs/. Set X1AGENT_DEPLOYMENT=<basedomain>." >&2
      ls -1 "$INSTALLS_DIR" | grep -v example | sed 's/\.local$//; s/^/  /' >&2
      exit 1
    fi
    ACTIVE="$c"
  done
  if [[ -z "$ACTIVE" ]]; then
    echo "[rotate-surreal] no deployment files in $INSTALLS_DIR" >&2
    exit 1
  fi
  ENV_FILE="$ACTIVE"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[rotate-surreal] $ENV_FILE not found" >&2
  exit 1
fi

DEPLOYMENT="$(basename "$ENV_FILE" .local)"
echo "[rotate-surreal] deployment: $DEPLOYMENT"
echo "[rotate-surreal] install:    $ENV_FILE"

NEW_PASS="$(openssl rand -hex 32)"

# Replace existing SURREALDB_ROOT_PASSWORD line in place; otherwise append.
# Uses portable awk (no GNU sed -i tricks; macOS friendly).
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if grep -qE '^SURREALDB_ROOT_PASSWORD=' "$ENV_FILE"; then
  awk -v new="SURREALDB_ROOT_PASSWORD=$NEW_PASS" '
    /^SURREALDB_ROOT_PASSWORD=/ { print new; next }
    { print }
  ' "$ENV_FILE" > "$TMP"
  mv "$TMP" "$ENV_FILE"
  trap - EXIT
  echo "[rotate-surreal] replaced SURREALDB_ROOT_PASSWORD in $ENV_FILE"
else
  printf '\n# SurrealDB root credential. Rotated by rotate-surrealdb-password.sh.\nSURREALDB_ROOT_PASSWORD=%s\n' "$NEW_PASS" >> "$ENV_FILE"
  rm -f "$TMP"
  trap - EXIT
  echo "[rotate-surreal] appended SURREALDB_ROOT_PASSWORD to $ENV_FILE"
fi

# Lock down permissions on the install file in case it was loose. The
# password is now in there in plaintext; make sure only the operator
# can read it.
chmod 600 "$ENV_FILE"

# Re-render the deployment values file so the next deploy picks the
# new password. install:plan reads installs/<basedomain>.local and
# writes deploy/helm/x1agent/values.<basedomain>.yaml.
echo "[rotate-surreal] running mise run install:plan to regenerate values.${DEPLOYMENT}.yaml"
mise run install:plan

echo
echo "[rotate-surreal] done. Next step:"
echo "    mise run deploy:prod"
echo
echo "[rotate-surreal] After deploy, the SurrealDB StatefulSet rolls."
echo "                 OLD password ('x1agent-surreal-root') will stop"
echo "                 working. Verify with a connection test before"
echo "                 declaring the rotation complete."
