-- Document commenting v1 (X1A-52) — Google-Docs-shaped commenting on shared
-- artifacts. See PRD-0005 in the orchestrator repo.
--
-- Storage model
-- =============
-- Shares are NOT a first-class table — they are derived from
-- `session_events` rows of type `agent.share`, with `share_id` carried in
-- the JSON payload. So this table cannot FK to a `shares.id` column; it
-- anchors on `(session_id, share_id)` and on `session_id` for cascade.
-- Cross-tenant scoping is enforced in the application layer by joining
-- sessions → agents → workspaces (mirroring the rest of the share
-- subsystem). Workspace_id is denormalized onto the row for cheap admin
-- listings and for the NATS subscriber on X1A-55 — it must equal
-- `(SELECT a.workspace_id FROM sessions s JOIN agents a ON a.id =
-- s.agent_id WHERE s.id = share_comments.session_id)` at insert time, and
-- is never updated.
--
-- Anchoring (markdown only)
-- =========================
-- For markdown shares the anchor JSONB shape is:
--   { "selection": { "start_line": 12, "start_col": 4,
--                    "end_line": 14, "end_col": 18,
--                    "quoted_text": "<selected text>" } }
-- For HTML shares (or any share-scoped thread) `anchor_json` is NULL and
-- `comment_scope = 'share'`. v1 assumes immutable share snapshots — anchor
-- stability under mutation is a v2 problem.
--
-- (share_id, thread_id, seq) is the natural key for an event-sourced
-- thread: every comment in a thread has a unique seq starting at 1, and
-- (share_id, thread_id) groups them. The application picks `seq` with
-- `coalesce(max(seq), 0) + 1` under the unique index — concurrent appends
-- are serialised by the unique-violation retry pattern used elsewhere in
-- the codebase (see SessionEventDuplicateError).

CREATE TABLE share_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Composite logical key (share_id, thread_id, seq). thread_id groups
  -- comments anchored to the same selection (or to the same share-level
  -- thread); seq orders comments within a thread.
  share_id TEXT NOT NULL,
  thread_id UUID NOT NULL,
  seq INT NOT NULL CHECK (seq >= 1),

  -- The session that produced the share. Comments cascade-delete with
  -- the session (and via session_events, with the share itself).
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  -- Denormalised workspace_id — set from the session's agent at insert
  -- time, never updated. Lets the workspace shares index and the
  -- X1A-55 wake plumbing scope without re-joining.
  workspace_id UUID NOT NULL,

  -- Share type at time of post — informational so the GET payload can
  -- include it without re-reading the event. Validated against the
  -- ShareType enum in the application layer.
  share_type TEXT NOT NULL,

  -- 'passage' threads carry anchor_json + only apply to markdown shares.
  -- 'share' threads have anchor_json = NULL and apply to any commentable
  -- share-type (markdown OR html in v1).
  comment_scope TEXT NOT NULL CHECK (comment_scope IN ('passage', 'share')),
  anchor_json JSONB,

  body TEXT NOT NULL,

  -- Authorship — exactly one of (author_user_id, author_session_id) is
  -- expected to be non-null. author_session_id is set when an agent
  -- posts via the share_comment MCP tool. author_user_id is set when a
  -- human posts via the REST API.
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  CHECK (
    (author_user_id IS NOT NULL) OR (author_session_id IS NOT NULL)
  ),

  -- 'passage' scope requires anchor_json. 'share' scope forbids it.
  CHECK (
    (comment_scope = 'passage' AND anchor_json IS NOT NULL)
    OR
    (comment_scope = 'share' AND anchor_json IS NULL)
  ),

  -- Resolution is per-thread. We record it on the first comment of the
  -- thread for simplicity — every row in the thread is queryable, and
  -- the application coalesces resolve state by max(resolved_at) over
  -- the thread. resolved_by_user_id is whoever flipped the resolve bit.
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Audit timestamps. Edits update body + updated_at; anchor is immutable
  -- once written so we don't bother tracking anchor-edit time.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Append-order uniqueness within a thread. Concurrent INSERTs race on
  -- this index; the loser retries with seq+1 in the adapter.
  UNIQUE (share_id, thread_id, seq)
);

-- "List comments on this share" — the GET-by-share path. Returns rows
-- grouped by thread in the application layer.
CREATE INDEX idx_share_comments_share ON share_comments (share_id, created_at);

-- "Resolve thread_id -> share_id" — the IDOR resolver. The MCP tool and
-- thread-scoped routes start here.
CREATE INDEX idx_share_comments_thread ON share_comments (thread_id);

-- "Workspace shares index needs comment counts" — supports a future
-- workspace-level "documents with comments" view. Cheap to add now.
CREATE INDEX idx_share_comments_workspace_created
  ON share_comments (workspace_id, created_at DESC);

-- Bump updated_at on body edit. Anchor is immutable so we don't gate
-- the trigger on column-set.
CREATE OR REPLACE FUNCTION share_comments_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_share_comments_updated_at
  BEFORE UPDATE ON share_comments
  FOR EACH ROW EXECUTE FUNCTION share_comments_set_updated_at();
