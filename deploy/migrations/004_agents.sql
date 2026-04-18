-- 004_agents
-- Agent configurations live inside a workspace. An agent describes what
-- kind of runtime to spin up (claude_code, mastra), the system prompt,
-- its cron schedule, and which GitHub repos are mounted at session start.

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  runtime_type TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  heartbeat_md TEXT NOT NULL DEFAULT '',
  schedule TEXT,            -- NULL means manual-only; otherwise a cron expression
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS agents_workspace_id_idx ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS agents_schedule_active_idx
  ON agents(schedule, is_active)
  WHERE schedule IS NOT NULL AND is_active = true;

-- GitHub repos linked to an agent. Actual install/installation_id wiring
-- lands with the GitHub App integration milestone.
CREATE TABLE IF NOT EXISTS agent_repos (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,              -- owner/repo
  installation_id BIGINT,                    -- GitHub App installation, NULL until linked
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, repo_full_name)
);

INSERT INTO schema_migrations (version) VALUES ('004_agents')
  ON CONFLICT DO NOTHING;
