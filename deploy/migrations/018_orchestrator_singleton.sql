-- Orchestrator singleton enforcement.
--
-- An orchestrator agent may have at most one non-terminal session
-- (status IN 'pending' or 'running') at any moment. The application
-- layer's "find or create" in trigger-session and spawn-child-session
-- handles this for the happy path, but concurrent inserts (double-
-- click, two browser tabs, orchestrator + scheduler racing) can bypass
-- a TOCTOU check and produce duplicate live sessions.
--
-- This trigger enforces the invariant at the storage layer so no
-- insert path — application code, direct SQL, future MCP endpoint —
-- can violate it. For workers and scheduled agents the trigger is
-- a no-op.
--
-- We take a row-level lock on the parent agent so two concurrent
-- inserts for the same agent serialize at the trigger level. Under
-- default READ COMMITTED isolation, the second insert waits for the
-- first to commit, then sees the newly-created session and raises
-- the unique_violation.
--
-- Error shape: SQLSTATE 23505 ('unique_violation') with a message
-- the application can parse if it wants a custom error class. Most
-- callers should have already done the find-or-create, so hitting
-- this trigger indicates either a bug or a real race — worth logging.

CREATE OR REPLACE FUNCTION enforce_orchestrator_singleton()
RETURNS TRIGGER AS $$
DECLARE
  agent_kind TEXT;
BEGIN
  -- Row-lock the agent so concurrent inserts for the same agent
  -- serialize. If the agent row doesn't exist we let the existing
  -- foreign-key check reject the insert; we only guard the kind here.
  SELECT kind INTO agent_kind
  FROM agents
  WHERE id = NEW.agent_id
  FOR UPDATE;

  IF agent_kind = 'orchestrator' AND EXISTS (
    SELECT 1
    FROM sessions
    WHERE agent_id = NEW.agent_id
      AND status IN ('pending', 'running')
      AND id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION
      'orchestrator % already has a live session', NEW.agent_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_orchestrator_singleton
  BEFORE INSERT ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_orchestrator_singleton();
