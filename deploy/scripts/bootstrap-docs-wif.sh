#!/usr/bin/env bash
# Bootstrap Workload Identity Federation so GitHub Actions can deploy
# the docs site (docs.x1agent.com) to Cloud Run without storing JSON keys.
#
# Run once per GCP project. Idempotent.
#
# IAM is resource-scoped: the deployer can ONLY redeploy the existing
# Cloud Run service `x1agent-docs`. It cannot create new services,
# delete services, impersonate other service accounts, or write to
# other Artifact Registry repos.
#
# Prerequisite: the Cloud Run service must already exist. Build the
# docs Dockerfile and `gcloud run deploy x1agent-docs --source docs/`
# once with operator credentials before bootstrapping CI/CD.
#
# Required env:
#   GITHUB_REPO   e.g. x1agent/x1agent  (the monorepo path)
#
# Optional env:
#   POOL_ID, PROVIDER_ID, DEPLOYER_SA, REGION, SERVICE

set -euo pipefail

PROJECT_ID="$(gcloud config get-value project 2>/dev/null)"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "error: no gcloud project configured" >&2
  exit 1
fi
if [[ -z "${GITHUB_REPO:-}" ]]; then
  echo "error: set GITHUB_REPO=<owner>/<repo> (e.g. x1agent/x1agent)" >&2
  exit 1
fi

POOL_ID="${POOL_ID:-github}"
PROVIDER_ID="${PROVIDER_ID:-x1agent-docs}"
DEPLOYER_SA="${DEPLOYER_SA:-x1agent-docs-deployer}"
DEPLOYER_EMAIL="${DEPLOYER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-x1agent-docs}"
AR_REPO="${AR_REPO:-cloud-run-source-deploy}"

PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
CLOUDBUILD_BUCKET="${PROJECT_ID}_cloudbuild"

echo "==> verifying Cloud Run service ${SERVICE} exists"
if ! gcloud run services describe "${SERVICE}" \
    --region="${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "error: Cloud Run service '${SERVICE}' not found in region ${REGION}." >&2
  echo "       Bring it up first with operator credentials:" >&2
  echo "         gcloud run deploy ${SERVICE} --source docs/ --region ${REGION} --allow-unauthenticated" >&2
  exit 1
fi

echo "==> creating deployer service account ${DEPLOYER_EMAIL}"
gcloud iam service-accounts create "${DEPLOYER_SA}" \
  --display-name="x1agent-docs GitHub Actions deployer (resource-scoped)" \
  --project "${PROJECT_ID}" 2>/dev/null || echo "    already exists"

# IAM is eventually consistent — a freshly-created SA can be invisible
# to other gcloud commands for ~5-30s. Poll until it resolves so the
# subsequent add-iam-policy-binding calls don't race.
echo "    waiting for SA to propagate..."
for _ in $(seq 1 30); do
  if gcloud iam service-accounts describe "${DEPLOYER_EMAIL}" \
       --project="${PROJECT_ID}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> ensuring Artifact Registry repo '${AR_REPO}' exists in ${REGION}"
gcloud artifacts repositories create "${AR_REPO}" \
  --location="${REGION}" \
  --repository-format=docker \
  --project "${PROJECT_ID}" 2>/dev/null || echo "    already exists"

echo "==> ensuring Cloud Build staging bucket gs://${CLOUDBUILD_BUCKET} exists"
gcloud storage buckets create "gs://${CLOUDBUILD_BUCKET}" \
  --location="${REGION}" \
  --project "${PROJECT_ID}" 2>/dev/null || echo "    already exists"

echo
echo "==> granting RESOURCE-SCOPED roles (the deployer can only touch this service)"

gcloud run services add-iam-policy-binding "${SERVICE}" \
  --region="${REGION}" \
  --member="serviceAccount:${DEPLOYER_EMAIL}" \
  --role="roles/run.developer" \
  --project "${PROJECT_ID}" \
  --condition=None \
  >/dev/null
echo "    bound roles/run.developer on Cloud Run service '${SERVICE}'"

gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
  --member="serviceAccount:${DEPLOYER_EMAIL}" \
  --role="roles/iam.serviceAccountUser" \
  --project "${PROJECT_ID}" \
  >/dev/null
echo "    bound roles/iam.serviceAccountUser on runtime SA '${RUNTIME_SA}'"

gcloud artifacts repositories add-iam-policy-binding "${AR_REPO}" \
  --location="${REGION}" \
  --member="serviceAccount:${DEPLOYER_EMAIL}" \
  --role="roles/artifactregistry.writer" \
  --project "${PROJECT_ID}" \
  >/dev/null
echo "    bound roles/artifactregistry.writer on AR repo '${AR_REPO}'"

gcloud storage buckets add-iam-policy-binding "gs://${CLOUDBUILD_BUCKET}" \
  --member="serviceAccount:${DEPLOYER_EMAIL}" \
  --role="roles/storage.objectAdmin" \
  --project "${PROJECT_ID}" \
  >/dev/null
echo "    bound roles/storage.objectAdmin on bucket 'gs://${CLOUDBUILD_BUCKET}'"

# No secrets needed for docs — it's a static Starlight build, no runtime
# credentials. (Skipping the secretmanager binding entirely.)

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${DEPLOYER_EMAIL}" \
  --role="roles/cloudbuild.builds.builder" \
  --condition=None \
  >/dev/null
echo "    bound roles/cloudbuild.builds.builder PROJECT-LEVEL (Cloud Build can't be scoped finer)"

echo
echo "==> creating workload identity pool '${POOL_ID}'"
gcloud iam workload-identity-pools create "${POOL_ID}" \
  --location=global \
  --display-name="GitHub Actions" \
  --project "${PROJECT_ID}" 2>/dev/null || echo "    already exists"

echo "==> creating provider '${PROVIDER_ID}'"
gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
  --location=global \
  --workload-identity-pool="${POOL_ID}" \
  --display-name="GitHub OIDC for ${GITHUB_REPO}" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository=='${GITHUB_REPO}'" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --project "${PROJECT_ID}" 2>/dev/null || echo "    already exists"

echo "==> binding repo to deployer SA"
gcloud iam service-accounts add-iam-policy-binding "${DEPLOYER_EMAIL}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_REPO}" \
  --project "${PROJECT_ID}" \
  >/dev/null

PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"

cat <<EOF

done. set these as repo *variables* in GitHub (Settings -> Secrets and variables -> Actions -> Variables):

  DOCS_GCP_PROJECT_ID         ${PROJECT_ID}
  DOCS_GCP_REGION             ${REGION}
  DOCS_WIF_PROVIDER           ${PROVIDER_RESOURCE}
  DOCS_WIF_SERVICE_ACCOUNT    ${DEPLOYER_EMAIL}

these are not secrets — they are repo-public identifiers, so 'Variables' is correct.
prefixed with DOCS_ so they don't collide with the platform repo's deploy variables.

scope summary (deployer can do, in this project):
  - update existing Cloud Run service '${SERVICE}'
  - act as runtime SA '${RUNTIME_SA}'
  - push images to AR repo '${AR_REPO}'
  - read/write Cloud Build staging in 'gs://${CLOUDBUILD_BUCKET}'
  - submit Cloud Build builds (project-level, unavoidable)

deployer CANNOT:
  - create new Cloud Run services
  - delete Cloud Run services
  - read any secrets (docs has none)
  - impersonate other service accounts
  - touch GKE / databases / DNS / IAM
EOF
