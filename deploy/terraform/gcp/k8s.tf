# Cluster-scoped K8s resources Terraform owns directly:
#   - x1agent namespace (so the chart can create-namespace=false later)
#   - x1agent-secrets ESO ClusterSecretStore pointing at GSM
#
# Why here, not in the Helm chart: the ClusterSecretStore is cluster-
# scoped (one per cluster), and ESO + its CRDs must already exist before
# the chart can reference it. Terraform applies in order: cluster up →
# this manifest → operator runs `helm install external-secrets ...` →
# operator runs `mise run install:apply` for the chart.
#
# The kubernetes_manifest resource requires terraform to reach the
# cluster's API server. We wire that via gke_cluster auth data.

data "google_client_config" "default" {
  depends_on = [google_container_cluster.x1agent]
}

provider "kubernetes" {
  host                   = "https://${google_container_cluster.x1agent.endpoint}"
  token                  = data.google_client_config.default.access_token
  cluster_ca_certificate = base64decode(google_container_cluster.x1agent.master_auth[0].cluster_ca_certificate)
}

resource "kubernetes_namespace_v1" "x1agent" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
      "app.kubernetes.io/name"       = "x1agent"
    }
  }

  # Don't fight the chart's own namespace creation if both run.
  lifecycle {
    ignore_changes = [metadata[0].annotations]
  }
}

# ESO ClusterSecretStore. Auth is via Workload Identity — ESO's pod runs
# under a K8s SA bound to the x1agent-eso GSA (see iam.tf). No service
# account key file ever exists for this. Requires ESO + its CRDs already
# installed (operator does this with helm before terraform apply, or as
# a follow-up apply after CRDs land).
resource "kubernetes_manifest" "secret_store" {
  manifest = {
    apiVersion = "external-secrets.io/v1"
    kind       = "ClusterSecretStore"
    metadata = {
      name = "x1agent-gsm"
      labels = {
        "app.kubernetes.io/managed-by" = "terraform"
        "app.kubernetes.io/name"       = "x1agent"
      }
    }
    spec = {
      provider = {
        gcpsm = {
          projectID = var.project_id
          # Workload Identity — no SA-key auth.
          auth = {
            workloadIdentity = {
              clusterLocation  = google_container_cluster.x1agent.location
              clusterName      = google_container_cluster.x1agent.name
              clusterProjectID = var.project_id
              serviceAccountRef = {
                name      = var.eso_k8s_service_account
                namespace = var.eso_namespace
              }
            }
          }
        }
      }
    }
  }

  # Terraform applies before ESO CRDs exist on first run. The operator
  # installs ESO between `terraform apply` (cluster + IAM) and the
  # chart install. This resource is on a separate target so a partial
  # apply pattern works:
  #   terraform apply -target=google_container_cluster.x1agent
  #   helm install external-secrets external-secrets/external-secrets ...
  #   terraform apply
  depends_on = [
    kubernetes_namespace_v1.x1agent,
    google_service_account_iam_binding.eso_wi,
  ]
}
