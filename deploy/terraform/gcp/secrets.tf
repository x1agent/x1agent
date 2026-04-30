# GSM secret resources. Created EMPTY — the operator populates each
# value once via:
#   echo -n "$VALUE" | gcloud secrets versions add x1agent-anthropic-api-key \
#     --project=<project> --data-file=-
#
# Why empty: secret values must NEVER round-trip through Terraform state
# (state files contain plaintext). Creating empty resources lets us own
# the Terraform graph for IAM bindings + lifecycle without ever touching
# values. ESO reads them at runtime via the ClusterSecretStore.
#
# `lifecycle.ignore_changes` covers two real-world cases:
#   - Secret value rotated by hand → don't reset on next apply
#   - Operator added labels via console → don't fight them

resource "google_secret_manager_secret" "secrets" {
  for_each  = toset(var.gsm_secret_names)
  secret_id = each.value
  project   = var.project_id

  labels = var.labels

  replication {
    auto {}
  }

  lifecycle {
    ignore_changes = [labels]
  }

  depends_on = [google_project_service.enabled]
}

# Bind the api + ESO GSAs to each secret. Per-secret bindings (not
# project-wide) so rogue code in either pod can only read these secrets,
# nothing else in the project.
resource "google_secret_manager_secret_iam_member" "api_accessor" {
  for_each  = google_secret_manager_secret.secrets
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "eso_accessor" {
  for_each  = google_secret_manager_secret.secrets
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.eso.email}"
}
