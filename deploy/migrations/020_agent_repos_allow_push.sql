-- Attachment-level push gating. An agent-repo attachment now carries
-- `allow_push` separately from `auto_push`. auto_push is about whether
-- the agent is expected to push on its own cadence; allow_push is the
-- enforcement: when false, the sidecar's credential helper refuses to
-- hand out credentials for push operations, so `git push` fails.
--
-- Safe-by-default: new attachments default to allow_push=false. An
-- operator has to explicitly opt into push per-repo via the UI or
-- API. Existing attachments are backfilled to true so the current
-- install doesn't silently break — today's attachments were added
-- before push gating existed and implicitly had full permissions.
--
-- See docs/src/content/docs/security/repo-access.md § The attachment
-- shape.

ALTER TABLE agent_repos
  ADD COLUMN IF NOT EXISTS allow_push BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing rows predate the flag and were effectively
-- push-enabled. Flip them so we don't break running sessions on
-- migration.
UPDATE agent_repos SET allow_push = true WHERE allow_push = false;
