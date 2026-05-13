-- X1A-110 — reply nesting on share comments.
--
-- Before this migration, every comment in a thread was a sibling under
-- a single thread_id, ordered by `seq`. The flyout rendered them
-- top-to-bottom flat. CEO 2026-05-13: replies should visually nest
-- under their immediate parent (Slack/Notion shape).
--
-- We introduce a nullable `parent_comment_id` reference:
--   - First comment in a thread: parent_comment_id = NULL.
--   - Reply to that comment: parent_comment_id = first comment's id.
--   - Reply-to-reply: rejected at the application layer in v1
--     (`nested_reply_not_supported`, 400). The depth-1 cap is a UX
--     decision to keep threads scannable. The column can carry the
--     reference once we lift the cap; today the app validates.
--
-- No FK constraint — same posture as the rest of `share_comments`,
-- which already anchors on `(share_id, thread_id, seq)` rather than
-- relying on referential integrity. Partial-index on the column so the
-- parent → children lookup is cheap; the WHERE clause keeps the index
-- skinny because the vast majority of rows are top-level comments
-- (NULL parent).
--
-- Existing rows: every pre-migration row has parent_comment_id = NULL
-- and continues to render as a top-level comment. No data migration
-- required.

ALTER TABLE share_comments
  ADD COLUMN parent_comment_id UUID;

CREATE INDEX share_comments_parent_id
  ON share_comments (parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;
