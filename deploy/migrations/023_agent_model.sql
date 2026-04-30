-- Per-agent model override.
--
-- Operators set the cluster-wide default via ANTHROPIC_MODEL env on the
-- api Deployment (see helm chart `config.ANTHROPIC_MODEL`). When agents
-- need a different model — a smaller cheaper model for a planning agent,
-- a Vertex-region-specific id, etc. — set this column. Empty / NULL =
-- fall back to the deployment-wide env.
--
-- Stored as text so the DB doesn't need to know the catalog of valid
-- ids — the SDK + Vertex/Anthropic API are the authority on what's live.

ALTER TABLE agents
  ADD COLUMN model TEXT;
