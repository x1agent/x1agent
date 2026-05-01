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
    # aiplatform = Agent Platform (formerly Vertex AI). Required for
    # the Anthropic publisher endpoint and any Gemini calls. Enabling
    # is free; you only pay for actual model calls.
    "aiplatform.googleapis.com",
    # cloudcommerceconsumerprocurement is the API behind partner-model
    # ToS acceptance in Model Garden. Without it, clicking "Enable" on
    # an Anthropic / OpenAI / Cohere / Voyage model card silently fails
    # AND the Studio "Enable APIs" banner stays up. We hit this on the
    # first install. Enabling is free.
    "cloudcommerceconsumerprocurement.googleapis.com",
    # Studio "Enable APIs" banner expects these as part of "full
    # platform capabilities." Enable up-front so first-run admins
    # don't see a persistent banner whose button silently no-ops.
    "generativelanguage.googleapis.com", # Gemini API surface
    "discoveryengine.googleapis.com",    # Agent Search / RAG primitives
    "dataform.googleapis.com",           # data pipeline UI dep
    "notebooks.googleapis.com",          # Vertex Workbench
    "cloudaicompanion.googleapis.com",   # Cloud Code / Gemini Code Assist
    "geminicloudassist.googleapis.com",  # post-rebrand assist surface
    "modelarmor.googleapis.com",         # safety / output filtering
  ])
}

resource "google_project_service" "enabled" {
  for_each                   = local.required_apis
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}
