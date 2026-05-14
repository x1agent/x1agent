# Static IP for the x1agent Ingress + DNS records pointing at it.
#
# Regional Network LB IP (not global HTTP(S) LB) — the chart uses
# ingress-nginx, whose Service is a regional LoadBalancer. ingress-nginx
# claims this IP via `controller.service.loadBalancerIP=<ip>` at install.
#
# DNS strategy: by default we create a Cloud DNS managed zone for the
# base domain and add A records for app.<base>, api.<base>, and the
# *.preview.<base> wildcard. The operator points the registrar's NS
# records at this zone's nameservers (or sets create_dns_zone=false
# and manages records elsewhere).

resource "google_compute_address" "ingress" {
  name         = "x1agent-ingress"
  description  = "Static IP fronting the x1agent ingress-nginx LB."
  region       = var.region
  address_type = "EXTERNAL"

  depends_on = [google_project_service.enabled]
}

resource "google_dns_managed_zone" "x1agent" {
  count       = var.create_dns_zone ? 1 : 0
  name        = var.dns_managed_zone_name
  dns_name    = "${var.base_domain}."
  description = "Managed zone for ${var.base_domain} (x1agent install)."

  labels = var.labels

  depends_on = [google_project_service.enabled]
}

# A records: app + api + wildcard preview → ingress IP. cert-manager
# issues TLS for all three via DNS-01 against this zone — including
# the wildcard, which Google-managed certs can't do.
resource "google_dns_record_set" "app" {
  count        = var.create_dns_zone ? 1 : 0
  name         = "app.${var.base_domain}."
  managed_zone = google_dns_managed_zone.x1agent[0].name
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.ingress.address]
}

resource "google_dns_record_set" "api" {
  count        = var.create_dns_zone ? 1 : 0
  name         = "api.${var.base_domain}."
  managed_zone = google_dns_managed_zone.x1agent[0].name
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.ingress.address]
}

resource "google_dns_record_set" "preview_wildcard" {
  count        = var.create_dns_zone ? 1 : 0
  name         = "*.preview.${var.base_domain}."
  managed_zone = google_dns_managed_zone.x1agent[0].name
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.ingress.address]
}

# nats.<base-domain> DNS record removed 2026-05-13 along with the
# public NATS WebSocket Ingress in the chart. The DNS name resolved to
# the ingress IP, which routed to NATS on port 8080 with `no_auth_user:
# x1agent-api` — P0 unauthenticated full-perms exposure. Browsers now
# reach NATS via the api's authenticated bridge at api.<base-domain>/api/ws.
#
# Existing deployments: terraform destroys this record on next apply
# (orphan, no consumer). Safe to remove.
