locals {
  share_artifacts_bucket_name = (
    var.share_artifacts_bucket != ""
    ? var.share_artifacts_bucket
    : "${var.project_id}-x1agent-shares"
  )
}

resource "google_storage_bucket" "share_artifacts" {
  name                        = local.share_artifacts_bucket_name
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  force_destroy               = false
  labels                      = var.labels

  public_access_prevention = "enforced"

  versioning {
    enabled = false
  }

  depends_on = [google_project_service.enabled]
}

resource "google_storage_bucket_iam_member" "share_artifacts_api_admin" {
  bucket = google_storage_bucket.share_artifacts.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_storage_bucket_iam_member" "share_artifacts_session_admin" {
  bucket = google_storage_bucket.share_artifacts.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.session.email}"
}
