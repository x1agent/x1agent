# Inputs the installer fills in from .env.local. Sensible defaults
# everywhere they make sense — the goal is `terraform apply` working
# off just `project_id` + `base_domain` for the common case.

variable "project_id" {
  description = "GCP project ID. Must already exist with billing enabled."
  type        = string
}

variable "base_domain" {
  description = "Base domain. URLs derived: app.<base>, api.<base>, *.preview.<base>."
  type        = string
}

variable "region" {
  description = "GCP region for the cluster + regional resources."
  type        = string
  default     = "us-central1"
}

variable "zones" {
  description = "Zones for the GKE nodepool. Single-zone for cost; multi-zone for HA."
  type        = list(string)
  default     = ["us-central1-a"]
}

variable "cluster_name" {
  description = "GKE cluster name."
  type        = string
  default     = "x1agent"
}

variable "node_machine_type" {
  description = "Worker node machine type. e2-standard-2 fits the platform + ~5-10 concurrent sessions on a single node."
  type        = string
  default     = "e2-standard-2"
}

variable "node_count" {
  description = "Number of nodes in the primary nodepool. 1 is fine for early-stage; bump manually when you outgrow it."
  type        = number
  default     = 1
}

variable "enable_autoscaling" {
  description = "Opt-in to GKE cluster autoscaling on the primary nodepool. Off by default — predictable cost beats elastic compute for non-perf-intensive workloads."
  type        = bool
  default     = false
}

variable "node_count_max" {
  description = "Max nodes when enable_autoscaling = true. Ignored otherwise."
  type        = number
  default     = 3
}

variable "use_spot_for_sessions" {
  description = "Add a separate Spot nodepool tainted for session pods. ~70-90% cheaper compute when you have real session burst load — opt-in until then."
  type        = bool
  default     = false
}

variable "dns_managed_zone_name" {
  description = "Cloud DNS managed zone name. Created if it doesn't exist."
  type        = string
  default     = "x1agent"
}

variable "create_dns_zone" {
  description = "Whether to create a new managed zone. Set false if you already manage the domain elsewhere."
  type        = bool
  default     = true
}

variable "namespace" {
  description = "K8s namespace the chart installs into."
  type        = string
  default     = "x1agent"
}

variable "api_k8s_service_account" {
  description = "K8s ServiceAccount name for the api pod. Must match the Helm chart."
  type        = string
  default     = "x1agent-api"
}

variable "session_k8s_service_account" {
  description = "K8s ServiceAccount name for agent session Jobs. Must match the Helm chart."
  type        = string
  default     = "x1agent-session"
}

variable "eso_namespace" {
  description = "Namespace where External Secrets Operator runs. Standard chart default is 'external-secrets'."
  type        = string
  default     = "external-secrets"
}

variable "eso_k8s_service_account" {
  description = "K8s ServiceAccount ESO creates for itself. Standard chart default is 'external-secrets'."
  type        = string
  default     = "external-secrets"
}

variable "artifact_registry_id" {
  description = "Artifact Registry repository ID (the part after the project + region)."
  type        = string
  default     = "x1agent"
}

variable "gsm_secret_names" {
  description = "GSM secret resource names to create (empty values; operator populates via gcloud)."
  type        = list(string)
  default = [
    "x1agent-jwt-secret",
    "x1agent-api-internal-token",
    "x1agent-anthropic-api-key",
    "x1agent-openai-api-key",
    "x1agent-google-oauth-client-id",
    "x1agent-google-oauth-client-secret",
    "x1agent-github-app-id",
    "x1agent-github-app-slug",
    "x1agent-github-app-client-id",
    "x1agent-github-app-client-secret",
    "x1agent-github-app-private-key",
    "x1agent-github-app-webhook-secret",
    "x1agent-slack-bot-token",
    "x1agent-slack-platform-client-id",
    "x1agent-slack-platform-client-secret",
    "x1agent-slack-platform-signing-secret",
    "x1agent-postgres-password",
    "x1agent-sentry-dsn-api",
    "x1agent-sentry-dsn-app",
    "x1agent-sentry-dsn-sidecar",
    "x1agent-workspace-secrets-master-key",
  ]
}

variable "labels" {
  description = "Labels applied to GCP resources for cost attribution."
  type        = map(string)
  default = {
    managed-by = "terraform"
    app        = "x1agent"
  }
}
