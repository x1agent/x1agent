-- Fix MCP catalog URLs that were stored as the OAuth audience identifier
-- (RFC 9728 `resource` field) instead of the actual MCP endpoint URL.
--
-- Background: prior versions of catalog-service.ts stored
-- `discovery.resource.resource` as the catalog `url`. For MCP servers
-- whose protected-resource metadata declares the resource as the
-- ORIGIN (Linear: `resource: "https://mcp.linear.app"`) while the
-- actual MCP endpoint sits at a sub-path, this caused the pod-side
-- proxy to POST to the origin and receive 404. Linear and similar
-- providers got registered with the wrong URL.
--
-- This migration repoints the known-affected curated entries.
-- Idempotent: only touches rows with the broken value.

UPDATE mcp_catalog_entries
SET url = 'https://mcp.linear.app/mcp'
WHERE name = 'linear'
  AND url IN ('https://mcp.linear.app', 'https://mcp.linear.app/sse');

UPDATE mcp_catalog_entries
SET url = 'https://mcp.sentry.dev/mcp'
WHERE name = 'sentry'
  AND url = 'https://mcp.sentry.dev/sse';
