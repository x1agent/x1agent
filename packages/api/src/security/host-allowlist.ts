/**
 * Host header allowlist — defense-in-depth against DNS rebinding.
 *
 * The TLS certificate pin is the primary defense (a foreign hostname
 * rebinding to our IP fails the cert match). This adds a second
 * layer: even if a future LB / cluster ingress had an unexpectedly
 * broad cert, an inbound request whose `Host:` header doesn't match
 * the install's known hostnames is rejected with 421 Misdirected
 * Request.
 *
 * Allowed hosts:
 *   - the api's public URL host (PUBLIC_URL, API_PUBLIC_URL)
 *   - the install's BASE_DOMAIN, plus any subdomain (covers preview
 *     hosts like <slug>.preview.<base>)
 *   - localhost / 127.0.0.1 / bare IPv4 — for kubelet probes and
 *     in-cluster Service traffic that sends Host: <pod-ip>:<port>
 *
 * Set HOST_HEADER_CHECK=disabled to skip enforcement when the api is
 * fronted by a known-good LB that rewrites Host (rare).
 */
export interface HostAllowlistConfig {
  /** Public URL hostnames whose `host` part should always be accepted. */
  readonly urls: readonly string[];
  /** BASE_DOMAIN — the apex; subdomains of it are also accepted. */
  readonly baseDomain?: string;
  /** When true, isHostAllowed always returns true (bypass). */
  readonly disabled?: boolean;
}

export function buildHostAllowlist(cfg: HostAllowlistConfig): {
  isAllowed: (host: string | undefined) => boolean;
  hosts: readonly string[];
} {
  if (cfg.disabled) {
    return { isAllowed: () => true, hosts: [] };
  }
  const hosts = new Set<string>();
  for (const u of cfg.urls) {
    try {
      hosts.add(new URL(u).host.toLowerCase());
    } catch {
      // ignore unparseable URLs at boot
    }
  }
  if (cfg.baseDomain) hosts.add(cfg.baseDomain.toLowerCase());
  hosts.add("localhost");
  hosts.add("127.0.0.1");
  const base = cfg.baseDomain?.toLowerCase();
  const list = [...hosts];

  return {
    isAllowed: (host) => {
      if (!host) return false;
      const h = host.toLowerCase().split(":")[0]!;
      if (list.includes(h)) return true;
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return true;
      if (base && (h === base || h.endsWith(`.${base}`))) return true;
      return false;
    },
    hosts: list,
  };
}
