-- Custom hostnames (aliases) for preview environments.
--
-- Operators want to point a vanity domain (e.g. app.<customer>.com) at
-- a preview slot. The preview-provider's Ingress is single-host today;
-- adding alias_hosts lets the same workspace UI register additional
-- hostnames per environment, and the provider materializes one extra
-- TLS entry + Ingress rule per alias on the next deploy.
--
-- Each entry is a bare hostname (no scheme, no path) validated at the
-- API layer against RFC 1123 hostname rules. Empty array by default.
-- Cert provisioning is delegated to cert-manager's ingress-shim via a
-- cluster-issuer annotation the provider emits when aliases are
-- present.
--
-- The list is small and the row is rewritten in-place on PUT, so jsonb
-- (matching env_var_names) is the right shape — no separate table.

ALTER TABLE preview_environments
  ADD COLUMN alias_hosts JSONB NOT NULL DEFAULT '[]'::jsonb;
