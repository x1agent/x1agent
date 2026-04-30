# GKE Standard cluster. v1 shape:
#   - regional control plane
#   - public master + master authorized networks empty (simplest first install;
#     tighten with master_authorized_networks_config in a follow-up)
#   - Workload Identity enabled (drives the GSM access pattern)
#   - default node pool removed; explicit pool below
#   - autoscaling OFF by default — predictable cost beats elastic compute
#     for the non-perf-intensive v1 workload. Flip enable_autoscaling=true
#     when you actually have load to chase.

resource "google_container_cluster" "x1agent" {
  provider = google-beta
  name     = var.cluster_name
  location = var.region

  # Off so `terraform destroy` actually destroys without manual override.
  # Re-enable in production via a follow-up apply once an install matters.
  deletion_protection = false

  # We manage our own node pool below; remove the default.
  remove_default_node_pool = true
  initial_node_count       = 1

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  # VPC-native (alias IP) — required for NEG-backed services that the
  # GCE Ingress relies on.
  networking_mode = "VPC_NATIVE"
  ip_allocation_policy {}

  release_channel { channel = "REGULAR" }

  resource_labels = var.labels

  depends_on = [google_project_service.enabled]
}

# Primary nodepool. Fixed-size by default. Autoscaling is opt-in: when
# enable_autoscaling = true, GKE manages min=node_count → max=node_count_max
# instead of pinning replicas to node_count.
resource "google_container_node_pool" "primary" {
  provider = google-beta
  name     = "primary"
  cluster  = google_container_cluster.x1agent.name
  location = google_container_cluster.x1agent.location

  # Fixed size when autoscaling is off; initial size only when on.
  node_count         = var.enable_autoscaling ? null : var.node_count
  initial_node_count = var.enable_autoscaling ? var.node_count : null

  dynamic "autoscaling" {
    for_each = var.enable_autoscaling ? [1] : []
    content {
      min_node_count = var.node_count
      max_node_count = var.node_count_max
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type = var.node_machine_type
    image_type   = "COS_CONTAINERD"
    disk_size_gb = 50
    disk_type    = "pd-standard"

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    labels = var.labels
  }
}

# Optional Spot nodepool for session pods. Tainted so only pods that
# explicitly tolerate it land here. Sessions are idempotent (re-run on
# eviction) so Spot is a good fit for variable cost when burst arrives.
resource "google_container_node_pool" "sessions_spot" {
  count    = var.use_spot_for_sessions ? 1 : 0
  provider = google-beta
  name     = "sessions-spot"
  cluster  = google_container_cluster.x1agent.name
  location = google_container_cluster.x1agent.location

  autoscaling {
    min_node_count = 0
    max_node_count = 5
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type = var.node_machine_type
    image_type   = "COS_CONTAINERD"
    disk_size_gb = 50
    disk_type    = "pd-standard"
    spot         = true

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    labels = merge(var.labels, { workload = "sessions" })

    taint {
      key    = "x1agent.io/sessions"
      value  = "true"
      effect = "NO_SCHEDULE"
    }
  }
}
