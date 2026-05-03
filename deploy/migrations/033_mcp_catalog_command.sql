-- Extend mcp_catalog_entries with a "command" shape alongside "image".
--
-- A huge fraction of MCP servers in the wild are not published as
-- container images — they're npx / uvx invocations the user runs in
-- their shell or wires into Claude Desktop's claude.json. Forcing
-- workspace admins to wrap every npx server in a custom Dockerfile
-- before they can register it is friction we don't need.
--
-- New shape:
--   image: TEXT, nullable    OCI ref ("ghcr.io/org/linear-mcp:1.2.0")
--   command: TEXT, nullable  Executable to run inside the platform's
--                            generic mcp-runner base image, e.g. "npx"
--   args: JSONB              Array of strings, e.g.
--                            ["-y", "@author/mercury-mcp"]
--
-- A row is valid iff exactly one of (image, command) is non-null. The
-- CHECK constraint enforces that here so a buggy application path
-- can't write a half-populated row.

ALTER TABLE mcp_catalog_entries
  ALTER COLUMN image DROP NOT NULL;

ALTER TABLE mcp_catalog_entries
  ADD COLUMN command TEXT,
  ADD COLUMN args JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE mcp_catalog_entries
  ADD CONSTRAINT mcp_catalog_entries_image_xor_command CHECK (
    (image IS NOT NULL AND command IS NULL)
    OR (image IS NULL AND command IS NOT NULL)
  );
