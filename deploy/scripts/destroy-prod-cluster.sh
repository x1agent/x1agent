#!/usr/bin/env bash
# Destroy the GKE cluster for exactly one configured production deployment.
# This intentionally leaves Terraform-managed DNS, IPs, buckets, Artifact
# Registry, Secret Manager, and IAM resources alone so the marketing website
# is not affected.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLS_DIR="$ROOT/installs"

if [[ -z "${X1AGENT_DEPLOYMENT:-}" ]]; then
  echo "[install:prod:destroy] set X1AGENT_DEPLOYMENT=<base-domain>; refusing to guess between installs." >&2
  exit 1
fi

DEPLOYMENT="$X1AGENT_DEPLOYMENT"
ENV_FILE="$INSTALLS_DIR/$DEPLOYMENT.local"
if [[ ! -f "$ENV_FILE" || "$DEPLOYMENT" == */* || "$DEPLOYMENT" == .* ]]; then
  echo "[install:prod:destroy] deployment file not found: $ENV_FILE" >&2
  exit 1
fi

val() {
  local key="$1"
  awk -v k="$key" '$0 ~ "^" k "=" { sub(/^[^=]*=/, ""); sub(/^"/, ""); sub(/"$/, ""); print; exit }' "$ENV_FILE"
}

PROJECT_ID="$(val GCP_PROJECT_ID)"
REGION="$(val GCP_REGION)"
CLUSTER="$(val GKE_CLUSTER_NAME)"
REGION="${REGION:-us-central1}"
CLUSTER="${CLUSTER:-x1agent}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "[install:prod:destroy] GCP_PROJECT_ID missing in $ENV_FILE" >&2
  exit 1
fi
for tool in gcloud awk; do
  command -v "$tool" >/dev/null || {
    echo "[install:prod:destroy] required command not found: $tool" >&2
    exit 1
  }
done

export CLOUDSDK_ACTIVE_CONFIG_NAME="${CLOUDSDK_ACTIVE_CONFIG_NAME:-x1agent}"

echo "[install:prod:destroy] target deployment: $DEPLOYMENT"
echo "[install:prod:destroy] GKE cluster:       $CLUSTER"
echo "[install:prod:destroy] GCP project:       $PROJECT_ID"
echo "[install:prod:destroy] region:             $REGION"
echo
echo "This deletes only the GKE cluster and its node pools."
echo "It leaves x1agent.com website/DNS and other project resources intact."
printf 'Type %s to confirm: ' "$DEPLOYMENT"
read -r confirmation
if [[ "$confirmation" != "$DEPLOYMENT" ]]; then
  echo "[install:prod:destroy] cancelled." >&2
  exit 1
fi

echo "[install:prod:destroy] deleting GKE cluster ${CLUSTER}…"
gcloud container clusters delete "$CLUSTER" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --quiet

echo "[install:prod:destroy] deleted GKE cluster $CLUSTER in $PROJECT_ID/$REGION."
