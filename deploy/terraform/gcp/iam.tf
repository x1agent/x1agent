# Two IAM identities for the install:
#
#   1. x1agent-api GSA — what the api ServiceAccount impersonates via
#      Workload Identity. Holds secretmanager.secretAccessor on the
#      install's GSM secrets so ESO can sync them. Held in this module
#      because Terraform owns the WI binding.
#
#   2. x1agent-eso GSA — separate GSA for the ESO ClusterSecretStore.
#      ESO runs in its own namespace (external-secrets) and uses this
#      GSA to read GSM. Splitting api creds from ESO creds limits blast
#      radius if either is compromised.

resource "google_service_account" "api" {
  account_id   = "x1agent-api"
  display_name = "x1agent api pod"
  description  = "Workload Identity GSA for the api Deployment in the x1agent namespace."

  depends_on = [google_project_service.enabled]
}

resource "google_service_account" "eso" {
  account_id   = "x1agent-eso"
  display_name = "x1agent External Secrets Operator"
  description  = "Used by ESO ClusterSecretStore to read GSM secrets."

  depends_on = [google_project_service.enabled]
}

# Session pod GSA — what the agent container impersonates via Workload
# Identity. Holds aiplatform.user so the Claude SDK's Vertex calls
# succeed without a service-account key file in the pod. Separate from
# the api GSA so credential blast radius stays bounded — a compromised
# session pod can call Vertex but cannot read GSM secrets or spawn
# additional sessions.
resource "google_service_account" "session" {
  account_id   = "x1agent-session"
  display_name = "x1agent session pod"
  description  = "Workload Identity GSA for agent session Jobs (Vertex AI access)."

  depends_on = [google_project_service.enabled]
}

# cert-manager GSA — for the DNS-01 ACME solver. cert-manager runs in
# its own namespace and uses this GSA to write _acme-challenge TXT
# records in Cloud DNS during certificate issuance + renewal.
# `roles/dns.admin` is what cert-manager's gcp-cloud-dns solver needs;
# scope is project-wide because the solver writes to whatever zone
# matches the certificate's domain. Trust boundary: only cert-manager's
# pod (annotated below) can impersonate this GSA.
resource "google_service_account" "cert_manager" {
  account_id   = "x1agent-cert-manager"
  display_name = "x1agent cert-manager"
  description  = "Used by cert-manager DNS-01 solver to write ACME challenge TXT records."

  depends_on = [google_project_service.enabled]
}

# Workload Identity binding for cert-manager. Operator annotates the
# K8s SA `cert-manager` in the `cert-manager` namespace at install time.
resource "google_service_account_iam_binding" "cert_manager_wi" {
  service_account_id = google_service_account.cert_manager.name
  role               = "roles/iam.workloadIdentityUser"
  members = [
    "serviceAccount:${var.project_id}.svc.id.goog[cert-manager/cert-manager]",
  ]
  depends_on = [google_container_cluster.x1agent]
}

# cert-manager DNS-01 solver needs to create + delete _acme-challenge
# TXT records in the install's Cloud DNS zone. roles/dns.admin is the
# documented minimum; project-scoped (cert-manager can only touch zones
# in this project).
resource "google_project_iam_member" "cert_manager_dns_admin" {
  project = var.project_id
  role    = "roles/dns.admin"
  member  = "serviceAccount:${google_service_account.cert_manager.email}"
}

# Workload Identity binding: K8s SA <namespace>/<name> impersonates the
# GCP SA. Both the api and ESO bindings use the same pattern.
resource "google_service_account_iam_binding" "api_wi" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.workloadIdentityUser"
  members = [
    "serviceAccount:${var.project_id}.svc.id.goog[${var.namespace}/${var.api_k8s_service_account}]",
  ]
  # WI pool `<project>.svc.id.goog` is registered as a side effect of
  # cluster creation (workload_identity_config). Without explicit
  # depends_on, terraform may run this binding in parallel with cluster
  # creation and fail "Identity Pool does not exist".
  depends_on = [google_container_cluster.x1agent]
}

resource "google_service_account_iam_binding" "eso_wi" {
  service_account_id = google_service_account.eso.name
  role               = "roles/iam.workloadIdentityUser"
  members = [
    # external-secrets is the conventional namespace for the ESO chart.
    # If you install ESO elsewhere, override the eso_namespace var.
    "serviceAccount:${var.project_id}.svc.id.goog[${var.eso_namespace}/${var.eso_k8s_service_account}]",
  ]
  depends_on = [google_container_cluster.x1agent]
}

# Session-pod WI binding. The K8s SA `x1agent-session` in the install
# namespace impersonates `x1agent-session@<project>.iam.gserviceaccount.com`.
# The Helm chart creates that K8s SA and the api spawns Jobs with
# `serviceAccountName: x1agent-session` so each agent pod inherits the
# binding.
resource "google_service_account_iam_binding" "session_wi" {
  service_account_id = google_service_account.session.name
  role               = "roles/iam.workloadIdentityUser"
  members = [
    "serviceAccount:${var.project_id}.svc.id.goog[${var.namespace}/${var.session_k8s_service_account}]",
  ]
  depends_on = [google_container_cluster.x1agent]
}

# Session pods need Vertex AI invoke permission. roles/aiplatform.user is
# the smallest role that grants generateContent + streamGenerateContent
# on Anthropic publisher models. Project-scoped — sessions can call any
# Vertex model in this project, but not read other resources.
resource "google_project_iam_member" "session_vertex_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.session.email}"
}

# Both GSAs need GSM access. Scope them to ONLY the install's secrets
# (not project-wide) by binding at the secret resource level — see
# secrets.tf, where each google_secret_manager_secret_iam_member binds
# both GSAs to that specific secret.

# The api GSA also needs limited Cloud Logging write (so business-event
# logs from the api land in Cloud Logging without the operator wiring
# extra exporters). roles/logging.logWriter is the smallest viable role.
resource "google_project_iam_member" "api_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# Cloud Monitoring metric write — same rationale, smallest role.
resource "google_project_iam_member" "api_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# The api needs Vertex AI predict so /admin/anthropic-models can run
# 1-token rawPredict probes against publisher models (curation page).
# Without this every probe returns "Permission
# 'aiplatform.endpoints.predict' denied". Scope matches the session
# SA's aiplatform.user — tighter scoping would need per-model IAM
# conditions we don't have a use case for.
resource "google_project_iam_member" "api_vertex_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.api.email}"
}
