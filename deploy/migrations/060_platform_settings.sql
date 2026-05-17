-- Generic key/value store for platform-admin-managed configuration
-- that doesn't justify its own table. Each entry is a JSONB value so
-- callers store typed shapes (strings, numbers, small structs) without
-- column-shape churn.
--
-- First caller (X1A-145): anthropic.summary_model — the model id the
-- Vertex / api_key session summarizer uses, replacing the boot-time
-- ANTHROPIC_SUMMARY_MODEL env var with an admin-selectable runtime
-- setting.
--
-- Updated_by is the email of the platform admin who last wrote the
-- value. Used for an audit trail in the admin UI; nullable for rows
-- written by migrations or installers.

CREATE TABLE platform_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);

COMMENT ON TABLE platform_settings IS
  'Platform-admin-scoped key/value config. Workspace-scoped settings live in workspace_settings (TBD).';
