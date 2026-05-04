-- Allow deleting a session and have its children + child-of-children
-- (agent-spawned sessions) sweep along with it. Previously
-- parent_session_id was ON DELETE SET NULL, which (a) leaves orphaned
-- "agent-triggered" rows that violate the existing CHECK requiring
-- parent_session_id to be non-null when triggered_by='agent', and
-- (b) makes single-row DELETE fail at the constraint.
--
-- Cascading is the right model — a parent session's children only
-- exist because that parent ran. Deleting the parent without
-- removing them leaves dangling history that isn't reachable from
-- anywhere in the UI anyway.
--
-- Sibling FKs (session_events, token_usage, session_user_shares)
-- already cascade on session delete. Resume-pointer (resumed_from)
-- stays SET NULL — a follow-on session that resumed from the deleted
-- one is its own first-class row that should survive.

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_parent_session_id_fkey;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_parent_session_id_fkey
  FOREIGN KEY (parent_session_id)
  REFERENCES sessions(id)
  ON DELETE CASCADE;
