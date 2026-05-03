-- Workspace-scoped secret store. Named values (e.g. MERCURY_API_TOKEN,
-- GOOGLE_DRIVE_CLIENT_SECRET) that MCP server attachments and other
-- runtime references resolve via ${NAME} template syntax.
--
-- Storage shape — v1 (this migration):
--   * Encrypted at rest in Postgres with AES-256-GCM.
--   * Master key from env (WORKSPACE_SECRETS_MASTER_KEY, hex-encoded 32B).
--   * Rotating the master key requires re-encrypting all rows; that
--     procedure isn't built yet — for now, treat the master key as
--     forever-immutable for a deployment. Document this limitation.
--   * No GET /value endpoint exists. Operators rotate by setting again.
--
-- Storage shape — v2 (target, documented in docs/providers/mcp-servers.md):
--   * Plaintext lands at the API once and is written to a Kubernetes
--     Secret in the workspace's namespace (RBAC-scoped to the API and
--     the session pod's SA only). The Postgres row keeps only metadata.
--   * Migration path: drop ciphertext/nonce/auth_tag columns once a
--     k8s_secret_ref column is populated for every row.
--
-- Names are uppercase + digits + underscore, matching the bare-reference
-- syntax (^\$\{[A-Z_][A-Z0-9_]*\}$) used by all consumers.

CREATE TABLE workspace_secrets (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- The reference name. Workspaces can't have two secrets with the
  -- same name. Validated at the API layer; the regex isn't enforced
  -- in SQL because Postgres regex is per-row and would slow inserts.
  name TEXT NOT NULL,

  -- AES-256-GCM ciphertext, nonce, auth tag. All bytea so the encoding
  -- doesn't leak through Node Buffer/string conversions.
  --
  -- v2 will drop these in favor of k8s_secret_ref.
  ciphertext BYTEA NOT NULL,
  nonce BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,

  -- is_set is redundant with the row's existence today (every row IS
  -- set; deleting the row clears the secret). It exists in the schema
  -- so that v2 can flip it during rotation between "metadata exists"
  -- and "K8s Secret materialized" without breaking the API contract.
  is_set BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,

  UNIQUE (workspace_id, name)
);

CREATE INDEX workspace_secrets_workspace_id_idx
  ON workspace_secrets (workspace_id);
