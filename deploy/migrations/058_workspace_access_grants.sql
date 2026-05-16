-- Per-workspace access grants. Two kinds:
--   * domain — any user whose email domain matches is auto-onboarded
--               into the workspace on their first sign-in.
--   * email  — exact email match. Same auto-onboard behaviour, scoped
--               to one person.
--
-- These are workspace-admin tools that sit ALONGSIDE invitations. Both
-- override the deployment-wide ALLOWED_DOMAINS gate via the existing
-- AccessGate port (see packages/domains/auth/src/adapters/postgres/
-- postgres-access-gate.ts). Difference:
--   * Invitation is per-email, expires by default, accepted-or-not flag.
--   * Grant is per-domain OR per-email, idempotent, no acceptance state
--     — the first sign-in materializes a membership automatically.
--
-- Tenancy: every grant is scoped to a single workspace_id. There is no
-- platform-wide grant — that's the deployment-level ALLOWED_DOMAINS
-- knob and the platform-admin tier. Workspace > install per CLAUDE.md.
--
-- expires_at: optional. NULL = never expires. Useful for "give the
-- contractor access until end of month".

CREATE TABLE workspace_access_grants (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- 'domain' or 'email'. CHECK constraint enforces.
  kind            TEXT NOT NULL,

  -- Normalised lowercase. For kind='domain' this is the bare domain
  -- ('foocorp.com'). For kind='email' it's the full address
  -- ('someone@foocorp.com').
  value           TEXT NOT NULL,

  -- Optional default role for users who materialize through this
  -- grant. NULL falls back to 'member' at the application layer.
  -- 'admin' is allowed but should be granted sparingly; the workspace
  -- UI surfaces it explicitly.
  default_role    TEXT,

  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT workspace_access_grants_kind_check
    CHECK (kind IN ('domain', 'email')),
  CONSTRAINT workspace_access_grants_default_role_check
    CHECK (default_role IS NULL OR default_role IN ('admin', 'member')),

  -- An admin can't accidentally double-create the same grant. A second
  -- POST with the same kind+value updates the existing row (idempotent)
  -- — application layer handles via ON CONFLICT.
  UNIQUE (workspace_id, kind, value)
);

-- AccessGate sign-in lookup hits this on every sign-in for an
-- email whose domain isn't allow-listed. Two access paths:
--   * exact (workspace_id, kind='email', value=<lower(email)>)
--   * domain match (kind='domain', value=<email domain>)
-- Index covers (kind, value); the expires_at filter stays in the
-- query (partial-index predicates require IMMUTABLE functions and
-- now() is STABLE, so an expires-aware partial index isn't possible).
CREATE INDEX workspace_access_grants_lookup_idx
  ON workspace_access_grants (kind, value);
