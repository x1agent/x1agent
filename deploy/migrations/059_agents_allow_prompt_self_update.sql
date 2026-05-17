-- Adds the opt-in switch for X1A-135 propose_prompt_patch.
--
-- When true, the agent's MCP tool list at pod-spec time includes
-- `propose_prompt_patch`. The agent can then propose changes to its
-- own per-agent system_prompt; each proposal lands as a draft row
-- (see follow-up migration adding agent_prompt_revisions) and only
-- mutates `agents.system_prompt` after an admin clicks Approve in the
-- UI. Default false so every existing agent stays opt-out.
--
-- This migration is intentionally column-only: no new table, no UI,
-- no MCP wiring. Lets future PRs build the rest of X1A-135 on top.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS allow_prompt_self_update boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN agents.allow_prompt_self_update IS
  'X1A-135: per-agent opt-in for the propose_prompt_patch MCP tool. '
  'When true, the agent can propose changes to its own system_prompt; '
  'approval still required from a workspace owner/admin.';
