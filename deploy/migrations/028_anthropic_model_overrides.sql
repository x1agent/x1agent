-- Admin-curated allowlist for Claude models exposed in the agent dropdown.
--
-- The Vertex Model Garden / Anthropic /v1/models catalog returns
-- everything the publisher offers — including @default preview aliases
-- that 400 with "not servable in region" and GA models the project
-- has no quota on. Operators don't want users picking those.
--
-- Rows here override the catalog. When at least one row exists with
-- enabled = true, the agent dropdown shows ONLY enabled rows. With
-- zero rows the dropdown falls back to the full catalog (so a fresh
-- install still works without admin curation).
--
-- last_probe_* columns store the most recent rawPredict probe result
-- so the admin page can show "this works" / "this 400s" without
-- re-probing on every page load. Probes are cheap (1 token) but not
-- free, and Vertex rate-limits them.

CREATE TABLE anthropic_model_overrides (
  -- Full Vertex / Anthropic model id, e.g. claude-sonnet-4-5@20250929
  -- or claude-3-5-haiku-20241022 — whatever listAnthropicModels returns.
  model_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_probe_status TEXT,
  last_probe_error TEXT,
  last_probed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
