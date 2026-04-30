# Artifact Registry repo for the install's images. One repo, three
# images (api / app / preview). Format=DOCKER, region matches the cluster
# so pulls don't cross regions.
#
# Tags: caller pushes <git-sha> + (optionally) :latest. The installer's
# render.ts derives image refs as <region>-docker.pkg.dev/<project>/x1agent/<name>.

resource "google_artifact_registry_repository" "x1agent" {
  location      = var.region
  repository_id = var.artifact_registry_id
  description   = "x1agent platform images (api, app, preview)."
  format        = "DOCKER"
  labels        = var.labels

  depends_on = [google_project_service.enabled]
}

# Let the GKE nodepool's default SA pull images. GKE node SAs already
# have storage.objectViewer cluster-wide for AR, but in tightened-IAM
# projects this binding is sometimes missing — explicit makes it
# survive a project-wide IAM cleanup.
resource "google_artifact_registry_repository_iam_member" "node_pull" {
  location   = google_artifact_registry_repository.x1agent.location
  repository = google_artifact_registry_repository.x1agent.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

# Default GCE service account — what GKE nodes run as out of the box.
data "google_compute_default_service_account" "default" {
  project    = var.project_id
  depends_on = [google_project_service.enabled]
}
