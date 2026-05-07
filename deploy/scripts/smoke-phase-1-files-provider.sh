#!/usr/bin/env bash
# Phase 1 smoke — verify the google-workspace provider deployment +
# sidecar bridge + agent files MCP work end-to-end.
#
# Prerequisites:
#   1. Phase 0 smoke green (smoke-phase-0-google-oauth.sh).
#   2. `mise run dev` has been restarted at least once since these
#      changes landed so devspace deploys the google-workspace pod
#      and rebuilds the agent + sidecar images.
#   3. An orchestrator session is running (or trigger a fresh one
#      from app.local.x1agent.dev/workspaces/x1agent).
#
# This script verifies the pieces incrementally — provider pod
# subscribed → sidecar bridge reachable from inside agent pod →
# end-to-end file list.
set -euo pipefail

NS="${NS:-x1agent}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.orbstack/k8s/config.yml}"

echo "==> 1. google-workspace provider pod is Running"
PROVIDER_POD=$(kubectl get pods -n "$NS" -l app=google-workspace -o jsonpath='{.items[0].metadata.name}' 2>&1 || true)
if [ -z "$PROVIDER_POD" ]; then
  cat >&2 <<EOF
FAIL — no google-workspace pod found.

Did you restart 'mise run dev'? The provider deployment (deploy/k8s/
dev/google-workspace.yaml) and image (deploy/docker/google-workspace.
dev.Dockerfile) are wired into devspace.yaml but a running 'devspace
dev' loaded the pre-Phase-1 config. Stop 'mise run dev' (Ctrl-C),
re-run 'mise run dev', wait for all pods Ready.
EOF
  exit 1
fi
echo "    pod=$PROVIDER_POD"
echo "    logs (first 5 lines, looking for NATS subscription confirmations):"
kubectl logs -n "$NS" "$PROVIDER_POD" 2>&1 | head -5 | sed 's/^/      /'
echo

echo "==> 2. session pod has TRIGGERING_USER_ID and the new agent image"
SESSION_POD=$(kubectl get pods -n "$NS" -l component=agent-session -o jsonpath='{.items[0].metadata.name}' 2>&1 || true)
if [ -z "$SESSION_POD" ]; then
  echo "FAIL — no agent session pod. Trigger one from the workspace home." >&2
  exit 1
fi
echo "    pod=$SESSION_POD"
USER_ID=$(kubectl exec -n "$NS" "$SESSION_POD" -c sidecar -- printenv TRIGGERING_USER_ID 2>&1 || true)
if [ -z "$USER_ID" ]; then
  cat >&2 <<EOF
FAIL — TRIGGERING_USER_ID not set on the sidecar.

Pod-spec was updated to inject this env from session.triggeredByUserId,
but the running session was created before 'mise run dev' picked up
the new pod-spec code. End the current session and start a new one.
EOF
  exit 1
fi
echo "    sidecar TRIGGERING_USER_ID=$USER_ID"
echo

echo "==> 3. agent → sidecar /files/list → NATS → provider → Drive"
echo "    (calling the sidecar HTTP route directly from inside the agent container,"
echo "     same path the files MCP uses)"
RESP=$(kubectl exec -n "$NS" "$SESSION_POD" -c agent -- \
  bash -c 'curl -sS -m 30 -X POST -H "Content-Type: application/json" \
    -d "{\"page_size\": 5}" http://localhost:9090/files/list' 2>&1)
echo "    raw reply (truncated):"
echo "    $(echo "$RESP" | head -c 500)"
echo

if echo "$RESP" | grep -q '"ok":true'; then
  COUNT=$(echo "$RESP" | grep -oE '"name":"[^"]+"' | wc -l | tr -d ' ')
  echo "🟢 Phase 1 substrate end-to-end VERIFIED."
  echo "    Drive returned $COUNT files via the full chain"
  echo "    (agent → sidecar → NATS → google-workspace provider → Drive API → back)"
elif echo "$RESP" | grep -q "permission_required"; then
  echo "FAIL — permission_required."
  echo "    The sidecar got TRIGGERING_USER_ID=$USER_ID but the api's"
  echo "    user-oauth-token endpoint says the user hasn't granted"
  echo "    drive.readonly. Run smoke-phase-0-google-oauth.sh first."
  exit 1
elif echo "$RESP" | grep -q "provider_timeout"; then
  echo "FAIL — provider didn't reply within 15s."
  echo "    Is the google-workspace pod subscribed? Check its logs:"
  echo "    kubectl logs -n $NS $PROVIDER_POD"
  exit 1
else
  echo "FAIL — unexpected reply shape." >&2
  exit 1
fi
