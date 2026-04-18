-- 005_github_installations
-- Tracks the x1agent GitHub App installations granted by users or orgs.
-- One row per installation_id (GitHub's own stable identifier). Agents
-- reference an installation via agents.linked_installation_id; all repos
-- on an agent share that one installation (invariant enforced in the
-- github + agents domains).

CREATE TABLE IF NOT EXISTS github_installations (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  installation_id BIGINT UNIQUE NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,                       -- 'User' | 'Organization'
  installed_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_selection TEXT NOT NULL DEFAULT 'selected',  -- 'all' | 'selected'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS github_installations_user_idx
  ON github_installations(installed_by_user_id)
  WHERE revoked_at IS NULL;

-- Move installation_id from agent_repos onto the agent itself. Schema
-- invariant: one agent ↔ one installation; all repos on an agent come
-- from that same GitHub installation (= same user/org).
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS linked_installation_id BIGINT;

ALTER TABLE agent_repos DROP COLUMN IF EXISTS installation_id;

INSERT INTO schema_migrations (version) VALUES ('005_github_installations')
  ON CONFLICT DO NOTHING;
