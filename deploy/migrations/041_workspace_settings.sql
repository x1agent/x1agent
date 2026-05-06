-- Workspace-scoped settings JSON column. One column, schemaless,
-- so future toggles ("require 2FA for admin actions",
-- "max concurrent sessions", etc.) don't each need a new migration.
-- Default is an empty object; the application layer applies typed
-- defaults when reading. NOT NULL so callers don't have to handle
-- the null branch.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';
