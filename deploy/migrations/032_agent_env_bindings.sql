-- Zone-2 agent env injection: workspace admin maps a workspace secret
-- directly to an env var the agent container will see at runtime.
--
-- Threat model (docs/security/agent-env.md): anything the agent runs
-- (bash, the LLM's tool calls, child processes) sees these vars in
-- plaintext. This is an explicit operator trust grant, not an
-- accidental side channel. Agents with any rows here display the
-- "operator-injected credentials" badge in the UI.
--
-- Materialization at session start: each row becomes a
-- valueFrom.secretKeyRef against the workspace's secret bundle. The
-- plaintext value never transits the pod spec or this table — the
-- ref column holds only the workspace secret's name.

CREATE TABLE agent_env_bindings (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  -- The env-var name the agent's process.env will see, e.g.
  -- ANTHROPIC_API_KEY. Same regex as workspace_secrets.name (the
  -- bare-reference syntax) — the application layer enforces it.
  env_name TEXT NOT NULL,

  -- The workspace secret name to resolve. References
  -- workspace_secrets.name within the same workspace_id (denormalized
  -- here through agents → workspace_id). FK is by name only because
  -- workspace_secrets.name has a per-workspace UNIQUE constraint.
  -- Application layer validates the name exists at write time;
  -- session launch fails loudly if the secret was deleted between
  -- binding and launch.
  secret_name TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- An agent can't bind the same env var twice. To rebind a value,
  -- update the existing row (the application's PUT semantics handle
  -- this idempotently).
  UNIQUE (agent_id, env_name)
);

CREATE INDEX agent_env_bindings_agent_id_idx
  ON agent_env_bindings (agent_id);
