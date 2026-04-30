# Provider config. Both google and google-beta are needed because some
# GKE features (Workload Identity binding via the kubernetes provider's
# annotation, ManagedCertificate CRD reachability) live across them.
provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# Enable the APIs the rest of the module depends on. Done first because
# every subsequent resource fails with a confusing error if its API is
# off. `disable_on_destroy = false` keeps the project sane if the user
# tears down — they probably want the APIs enabled for ad-hoc gcloud.
locals {
  required_apis = toset([
    "container.googleapis.com",            # GKE
    "compute.googleapis.com",              # network, IPs, certs
    "artifactregistry.googleapis.com",     # image repo
    "secretmanager.googleapis.com",        # GSM
    "iam.googleapis.com",                  # service accounts
    "iamcredentials.googleapis.com",       # Workload Identity
    "dns.googleapis.com",                  # Cloud DNS
    "cloudresourcemanager.googleapis.com", # IAM bindings
    # aiplatform = Vertex AI. Required when ANTHROPIC_PROVIDER=vertex
    # so the agent runtime can call Claude via Vertex. Enabling the API
    # is free; you only pay for actual model calls.
    "aiplatform.googleapis.com",
  ])
}

resource "google_project_service" "enabled" {
  for_each                   = local.required_apis
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}
