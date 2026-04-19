-- 007_agent_repos_branch
-- Per-repo branch specification. When a session starts, the sidecar clones
-- each linked repo into /workspace/{mount_path} and checks out this branch.
-- If the branch doesn't exist remotely, the sidecar creates it locally;
-- first push establishes it upstream via the installation token.

ALTER TABLE agent_repos
  ADD COLUMN IF NOT EXISTS branch TEXT NOT NULL DEFAULT 'main';

-- A reasonable mount path default: the repo's name (the part after the slash
-- in owner/repo). We stash it on the row rather than computing it every time
-- so the sidecar has a stable filesystem target.
ALTER TABLE agent_repos
  ADD COLUMN IF NOT EXISTS mount_path TEXT;

UPDATE agent_repos
  SET mount_path = split_part(repo_full_name, '/', 2)
  WHERE mount_path IS NULL;

ALTER TABLE agent_repos
  ALTER COLUMN mount_path SET NOT NULL;

-- Auto-push: when true, the sidecar commits + pushes any workspace changes
-- in this repo to a session-specific branch at session.completed.
ALTER TABLE agent_repos
  ADD COLUMN IF NOT EXISTS auto_push BOOLEAN NOT NULL DEFAULT false;

INSERT INTO schema_migrations (version) VALUES ('007_agent_repos_branch')
  ON CONFLICT DO NOTHING;
