-- Per-agent access grants — same (subject_kind, subject_id) shape as
-- session_user_shares so the resolver code is symmetrical.
--
-- Verbs:
--   view   — see in lists, read prompt + history
--   invoke — spawn sessions of this agent
--   edit   — change prompt, schedule, image, delete
--
-- The agent's owner (agents.owner_user_id) gets all three implicitly;
-- agent_grants only covers everyone else.
--
-- Workspace admins/owners bypass the grant table entirely — they see
-- everything (audit/compliance scope, can't be stripped).

ALTER TABLE agents
  ADD COLUMN owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace'
    CHECK (visibility IN ('private', 'workspace', 'via_grants'));

-- Backfill ownership from `created_by` for existing agents. Agents
-- with NULL created_by stay NULL (orphans visible only to admins).
UPDATE agents SET owner_user_id = created_by WHERE owner_user_id IS NULL;

CREATE TABLE agent_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL
    CHECK (subject_kind IN ('user', 'group', 'workspace', 'public')),
  subject_id UUID,
  verb TEXT NOT NULL CHECK (verb IN ('view', 'invoke', 'edit')),
  granted_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_grants_subject_id_shape CHECK (
       (subject_kind IN ('user','group') AND subject_id IS NOT NULL)
    OR (subject_kind IN ('workspace','public') AND subject_id IS NULL)
  )
);

CREATE UNIQUE INDEX idx_agent_grants_unique_subject
  ON agent_grants (agent_id, subject_kind, subject_id, verb)
  WHERE subject_id IS NOT NULL;

CREATE UNIQUE INDEX idx_agent_grants_unique_global_subject
  ON agent_grants (agent_id, subject_kind, verb)
  WHERE subject_id IS NULL;

CREATE INDEX idx_agent_grants_subject ON agent_grants (subject_kind, subject_id);
