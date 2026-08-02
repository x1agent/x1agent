-- 065_agent_skill_sources
-- Provider-neutral Agent Skills references. Each entry points at a public
-- GitHub repository plus an immutable or named git ref and an optional path
-- containing either SKILL.md or a plugin's skills/ directory.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS skill_sources jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE agents
  ADD CONSTRAINT agents_skill_sources_array
  CHECK (jsonb_typeof(skill_sources) = 'array');

INSERT INTO schema_migrations (version) VALUES ('065_agent_skill_sources')
ON CONFLICT (version) DO NOTHING;
