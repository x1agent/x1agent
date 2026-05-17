-- Adds the `collaborate` verb to the agent_grants check constraint.
--
-- Semantics: when a user has `collaborate` on agent A, every session
-- whose agent_id = A is visible to them AND they can publish messages
-- into it (composer + ws publish). Distinct from `invoke` (= spawn new
-- sessions of this agent) — a collaborator participates in sessions
-- the owner or someone else spawned.
--
-- The default tier behaviour is unchanged at the SQL layer: workspace
-- members on a `visibility='workspace'` agent get collaborate implicitly
-- (the resolver decides, no grant row needed). Explicit grants are for
-- `visibility='private'` and `'via_grants'` agents where the operator
-- has narrowed the access set.

ALTER TABLE agent_grants
  DROP CONSTRAINT agent_grants_verb_check;

ALTER TABLE agent_grants
  ADD CONSTRAINT agent_grants_verb_check
    CHECK (verb IN ('view', 'invoke', 'edit', 'collaborate'));
