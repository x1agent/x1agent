#!/usr/bin/env bash
# works end-to-end against a real Google sign-in.
#
# Run AFTER:
#   1. devspace.yaml + .env.local include GOOGLE_OAUTH_SCOPES with
#      drive.readonly. (Done in this commit.)
#   2. `mise run dev` has been restarted so devspace re-renders the
#      api deployment with the new scopes env. (Operator action —
#      `kubectl set env` mid-`devspace dev` gets reverted by the
#      reconciler within seconds.)
#   3. Operator has signed in via https://app.local.x1agent.dev/auth/google
#      (NOT the dev-bypass path) and consented to drive.readonly on
#      the Google consent screen.
#
# Exit non-zero on any failure step. All output is human-readable.
set -euo pipefail

NS="${NS:-x1agent}"
PROVIDER="${PROVIDER:-google}"
SCOPE="${SCOPE:-https://www.googleapis.com/auth/drive.readonly}"

if ! command -v kubectl >/dev/null; then
  echo "kubectl not on PATH" >&2
  exit 2
fi
export KUBECONFIG="${KUBECONFIG:-$HOME/.orbstack/k8s/config.yml}"

echo "==> 1. Find the user_oauth_tokens row for the active operator"
echo "    (assumes one user in the local DB; adjust if you have more)"
psql_query() {
  kubectl exec -n "$NS" deploy/postgres -- \
    bash -c "psql -U x1agent -d x1agent -t -A -F '|' -c \"$1\""
}
ROW=$(psql_query "SELECT user_id, provider, array_to_string(scopes_granted, ',') FROM user_oauth_tokens WHERE provider='$PROVIDER' LIMIT 1")
if [ -z "$ROW" ]; then
  cat >&2 <<EOF
FAIL — no user_oauth_tokens row for provider=$PROVIDER.

Did the operator sign in via /auth/google with consent? Bypass sign-in
does NOT populate the OAuth grant — it only sets identity. Check:

  1. Visit https://app.local.x1agent.dev/auth/google
  2. Complete the Google consent screen (must include the Drive scope)
  3. Re-run this script

If the consent screen errors with "redirect_uri_mismatch", add
https://api.local.x1agent.dev/auth/google/callback to the OAuth
client's Authorized redirect URIs in Google Cloud Console.

If the consent screen omits Drive, GOOGLE_OAUTH_SCOPES isn't in the
api pod's env. Run: kubectl exec -n $NS deploy/api-devspace -- \\
  printenv | grep GOOGLE_OAUTH_SCOPES
If absent, restart 'mise run dev' so devspace picks up the env.
EOF
  exit 1
fi
USER_ID="${ROW%%|*}"
SCOPES_REST="${ROW#*|*|}"
echo "    user_id=$USER_ID"
echo "    scopes_granted=$SCOPES_REST"

if ! echo "$SCOPES_REST" | grep -q "drive.readonly"; then
  echo "FAIL — drive.readonly not in granted scopes." >&2
  exit 1
fi
echo "    ✓ drive.readonly is granted"
echo

echo "==> 2. Hit /api/internal/user-oauth-token from inside the cluster"
INTERNAL_TOKEN=$(kubectl exec -n "$NS" deploy/api-devspace -- printenv API_INTERNAL_TOKEN)
if [ -z "$INTERNAL_TOKEN" ]; then
  echo "FAIL — API_INTERNAL_TOKEN unset on the api pod" >&2
  exit 1
fi

# Port-forward the api so curl from the host can hit it. Background
# the port-forward so we can clean it up on exit.
kubectl port-forward -n "$NS" deploy/api-devspace 30001:30001 >/dev/null 2>&1 &
PF_PID=$!
trap "kill $PF_PID 2>/dev/null || true" EXIT
sleep 2

URL="http://localhost:30001/api/internal/user-oauth-token?user_id=$USER_ID&provider=$PROVIDER&scope=$(printf %s "$SCOPE" | sed 's/:/%3A/g; s/\//%2F/g')"
RESP=$(curl -sS -o /tmp/phase0-token.json -w '%{http_code}' "$URL" -H "X-Internal-Token: $INTERNAL_TOKEN")
if [ "$RESP" != "200" ]; then
  echo "FAIL — token endpoint returned HTTP $RESP" >&2
  cat /tmp/phase0-token.json >&2
  exit 1
fi

ACCESS_TOKEN=$(grep -oE '"access_token":"[^"]+"' /tmp/phase0-token.json | sed 's/"access_token":"//;s/"$//')
if [ -z "$ACCESS_TOKEN" ]; then
  echo "FAIL — no access_token in response" >&2
  cat /tmp/phase0-token.json >&2
  exit 1
fi
echo "    ✓ got access_token (${#ACCESS_TOKEN} chars)"
echo

echo "==> 3. Call Google Drive API with the minted token"
DRIVE_RESP=$(curl -sS -o /tmp/phase0-drive.json -w '%{http_code}' \
  "https://www.googleapis.com/drive/v3/files?pageSize=3&fields=files(id,name)" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
if [ "$DRIVE_RESP" != "200" ]; then
  echo "FAIL — Drive API returned HTTP $DRIVE_RESP" >&2
  cat /tmp/phase0-drive.json >&2
  exit 1
fi

# Pretty-print the file names.
FILE_COUNT=$(grep -oE '"name":"[^"]+"' /tmp/phase0-drive.json | wc -l | tr -d ' ')
echo "    ✓ Drive API returned 200, $FILE_COUNT files visible:"
grep -oE '"name":"[^"]+"' /tmp/phase0-drive.json | sed 's/"name":"/      • /;s/"$//'
echo

echo "🟢 Phase 0 substrate end-to-end VERIFIED."
echo "   - user_oauth_tokens row exists with the granted scope"
echo "   - /api/internal/user-oauth-token returns a fresh access token"
echo "   - that access token successfully calls the Google Drive API"
echo
echo "Phase 1 (google-workspace provider deployment) can build on this."
