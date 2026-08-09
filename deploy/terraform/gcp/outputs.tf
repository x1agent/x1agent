# Outputs the installer reads to fill in Helm values, plus what the
# operator needs to manually configure DNS at their registrar.

output "cluster_name" {
  value       = google_container_cluster.x1agent.name
  description = "GKE cluster name."
}

output "cluster_location" {
  value       = google_container_cluster.x1agent.location
  description = "GKE cluster region."
}

output "cluster_endpoint" {
  value       = "https://${google_container_cluster.x1agent.endpoint}"
  description = "GKE control plane endpoint. Used by `gcloud container clusters get-credentials`."
  sensitive   = true
}

output "ingress_static_ip" {
  value       = google_compute_address.ingress.address
  description = "Regional static IP fronting x1agent's Traefik LB. Point app.<base> + api.<base> + *.preview.<base> at this when create_dns_zone=false."
}

output "ingress_static_ip_name" {
  value       = google_compute_address.ingress.name
  description = "Name of the static IP — used by Traefik via service.spec.loadBalancerIP at install."
}

output "dns_nameservers" {
  value       = var.create_dns_zone ? google_dns_managed_zone.x1agent[0].name_servers : []
  description = "Cloud DNS nameservers. Set these as the NS records at your registrar."
}

output "artifact_registry" {
  value       = "${google_artifact_registry_repository.x1agent.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.x1agent.repository_id}"
  description = "Artifact Registry path. Push images here as <this>/api:<tag>, etc."
}

output "share_artifacts_bucket" {
  value       = google_storage_bucket.share_artifacts.name
  description = "GCS bucket holding share content. Wired into the chart as shares.gcsBucket → GCS_ARTIFACTS_BUCKET env on api + session sidecars."
}

output "api_workload_identity_gsa" {
  value       = google_service_account.api.email
  description = "GSA email the api ServiceAccount impersonates. Goes into helm values cloud.gcp.workloadIdentityServiceAccount."
}

output "eso_workload_identity_gsa" {
  value       = google_service_account.eso.email
  description = "GSA email ESO uses. Annotate the external-secrets/external-secrets ServiceAccount with iam.gke.io/gcp-service-account=<this>."
}

output "session_workload_identity_gsa" {
  value       = google_service_account.session.email
  description = "GSA email agent session pods impersonate. The Helm chart wires this onto the x1agent-session ServiceAccount automatically."
}

output "cert_manager_workload_identity_gsa" {
  value       = google_service_account.cert_manager.email
  description = "GSA email cert-manager uses for DNS-01 challenges. Annotate cert-manager/cert-manager SA with iam.gke.io/gcp-service-account=<this>."
}

output "preview_build_workload_identity_gsa" {
  value       = google_service_account.preview_build.email
  description = "GSA email the Kaniko preview build Pod impersonates. Set helm values providers.preview.buildServiceAccountAnnotations.\"iam.gke.io/gcp-service-account\"=<this>."
}

output "gsm_secret_names" {
  value       = [for s in google_secret_manager_secret.secrets : s.secret_id]
  description = "Empty GSM secrets created. Populate values via gcloud secrets versions add."
}

output "next_steps" {
  value       = <<-EOT
    terraform apply complete. The orchestrator (`mise run install`) handles
    the remaining install phases automatically:
      - cluster credentials
      - operator helm installs (ESO, cert-manager, Traefik)
      - Workload Identity annotations
      - second terraform apply (ClusterSecretStore + ClusterIssuer)
      - GSM secret population
      - image build + push
      - helm install x1agent
      - cert wait

    %{if var.create_dns_zone}
    DNS delegation (one-time, at your domain registrar):
${join("\n", [for ns in google_dns_managed_zone.x1agent[0].name_servers : "       ${ns}"])}
    %{else}
    DNS records to create at your DNS provider:
       app.${var.base_domain}        A   ${google_compute_address.ingress.address}
       api.${var.base_domain}        A   ${google_compute_address.ingress.address}
       *.preview.${var.base_domain}  A   ${google_compute_address.ingress.address}
    %{endif}
  EOT
  description = "Post-terraform notes (DNS delegation if Cloud DNS, or A-record values otherwise). The install orchestrator does the rest."
}
