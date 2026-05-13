import { DomainError, type UserId } from "@x1agent/kernel";
import type { SessionId } from "./session.js";

/**
 * Document commenting v1 — Google-Docs-shaped commenting on shared
 * artifacts (X1A-52). Pure domain types + invariants; no I/O.
 *
 * Shares are not first-class rows in the DB — they are derived from
 * `session_events` of type `agent.share`. So the `shareId` on a comment
 * is the string id carried in that event payload, not an FK target.
 * Tenancy + lifecycle are anchored on `sessionId` (which has cascade
 * delete to comments via the migration).
 */

declare const threadIdBrand: unique symbol;
export type ShareThreadId = string & { readonly [threadIdBrand]: true };
export const ShareThreadId = (raw: string): ShareThreadId =>
  raw as ShareThreadId;

declare const commentIdBrand: unique symbol;
export type ShareCommentId = string & { readonly [commentIdBrand]: true };
export const ShareCommentId = (raw: string): ShareCommentId =>
  raw as ShareCommentId;

/**
 * `passage` is per-selection (markdown only). `share` is one thread
 * attached to the whole share (the only mode for HTML in v1).
 */
export type CommentScope = "passage" | "share";

const COMMENT_SCOPES: readonly CommentScope[] = ["passage", "share"] as const;
export function isCommentScope(v: string): v is CommentScope {
  return (COMMENT_SCOPES as readonly string[]).includes(v);
}

/**
 * Markdown-line-and-column anchor with a quoted-text fallback for
 * fuzz-match recovery if line numbers drift. v1 assumes immutable share
 * snapshots so the fallback is never exercised on the write path, but
 * it's persisted because mutability is a v2 problem we want a hook for.
 */
export interface PassageAnchor {
  selection: {
    start_line: number;
    start_col: number;
    end_line: number;
    end_col: number;
    quoted_text: string;
  };
}

/**
 * One row in `share_comments`. Comments are append-only; edits update
 * `body` (and `updatedAt`) but never `anchorJson`.
 */
export interface ShareComment {
  id: ShareCommentId;
  shareId: string;
  threadId: ShareThreadId;
  seq: number;
  sessionId: SessionId;
  workspaceId: string;
  shareType: string;
  commentScope: CommentScope;
  anchorJson: PassageAnchor | null;
  body: string;
  authorUserId: UserId | null;
  authorSessionId: SessionId | null;
  resolvedAt: Date | null;
  resolvedByUserId: UserId | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * X1A-110 — id of the parent comment this one replies to within the
   * same thread. `null` for the first comment in a thread.
   * Application-layer invariant (depth cap): if a comment has
   * parent_comment_id set, that parent's `parentCommentId` MUST be
   * null. The migration column accepts arbitrary depth so the cap can
   * be lifted later; v1 enforces it in `postShareComment`.
   */
  parentCommentId: ShareCommentId | null;
}

/**
 * v1 commentable share-types. `image | svg | csv | json | code | archive`
 * are phase 2 — the write path returns `share_type_not_commentable` for
 * those. Keep this list in sync with `ShareType` in the app's
 * `ShareCard.tsx`.
 */
const COMMENTABLE_SHARE_TYPES: ReadonlySet<string> = new Set([
  "document", // markdown — supports passage anchors
  "site", // html — share-level only
]);
export function isCommentableShareType(s: string): boolean {
  return COMMENTABLE_SHARE_TYPES.has(s);
}
export function supportsPassageAnchors(shareType: string): boolean {
  return shareType === "document";
}

// ── Errors ──────────────────────────────────────────────────────────

export class InvalidCommentScopeError extends DomainError {
  readonly code = "invalid_comment_scope";
  constructor(public readonly raw: string) {
    super(`'${raw}' is not a valid comment scope; expected passage or share`);
  }
}

export class InvalidScopeForShareTypeError extends DomainError {
  readonly code = "invalid_scope_for_share_type";
  constructor(scope: CommentScope, shareType: string) {
    super(
      `comment_scope='${scope}' is not allowed on share_type='${shareType}'`,
    );
  }
}

export class ShareTypeNotCommentableError extends DomainError {
  readonly code = "share_type_not_commentable";
  constructor(public readonly shareType: string) {
    super(`share_type='${shareType}' is not commentable in v1`);
  }
}

export class AnchorRequiredError extends DomainError {
  readonly code = "anchor_required";
  constructor() {
    super("comment_scope='passage' requires anchor selection");
  }
}

export class AnchorForbiddenError extends DomainError {
  readonly code = "anchor_forbidden";
  constructor() {
    super("comment_scope='share' must not carry an anchor");
  }
}

export class EmptyCommentBodyError extends DomainError {
  readonly code = "empty_comment_body";
  constructor() {
    super("comment body must not be empty");
  }
}

export class CommentBodyTooLongError extends DomainError {
  readonly code = "comment_body_too_long";
  constructor(public readonly limit: number) {
    super(`comment body exceeds ${limit} characters`);
  }
}

/**
 * X1A-110 — depth cap for reply nesting. v1 allows exactly one level
 * of indent: top-level comment → reply. Replying to a reply is
 * rejected so threads stay scannable. Lift this once we have a real
 * design for deep threads (and a way to render them without runaway
 * indentation on narrow viewports).
 */
export class NestedReplyNotSupportedError extends DomainError {
  readonly code = "nested_reply_not_supported";
  constructor() {
    super(
      "v1 supports replying to a top-level comment only; reply-to-reply is not supported",
    );
  }
}

/**
 * X1A-110 — `parent_comment_id` must reference a comment in the same
 * thread. Cross-thread parents are rejected to avoid the "reply
 * routes to a different thread" footgun.
 */
export class ParentCommentNotInThreadError extends DomainError {
  readonly code = "parent_comment_not_in_thread";
  constructor() {
    super("parent_comment_id must reference a comment in the same thread");
  }
}

export class ThreadNotFoundError extends DomainError {
  readonly code = "thread_not_found";
  constructor(public readonly threadId: string) {
    super(`thread '${threadId}' not found`);
  }
}

export class ThreadNotVisibleError extends DomainError {
  readonly code = "thread_not_visible";
  constructor() {
    super("the actor cannot see this thread");
  }
}

export class ShareNotFoundError extends DomainError {
  readonly code = "share_not_found";
  constructor() {
    super("share not found");
  }
}

export class CommentNotOwnedError extends DomainError {
  readonly code = "comment_not_owned";
  constructor() {
    super("only the author may edit or delete this comment");
  }
}

// ── Validation ──────────────────────────────────────────────────────

/** Hard ceiling — keeps the NATS payload bounded and the UI honest. */
export const MAX_COMMENT_BODY_LEN = 10_000;

/**
 * Validates body, scope/anchor coherence, and share-type compatibility.
 * Returns void on success; throws a DomainError subclass on failure so
 * routes can map exception → HTTP status uniformly.
 */
export function assertValidCommentInput(input: {
  body: string;
  scope: CommentScope;
  anchor: PassageAnchor | null;
  shareType: string;
}): void {
  const body = input.body.trim();
  if (body.length === 0) throw new EmptyCommentBodyError();
  if (input.body.length > MAX_COMMENT_BODY_LEN) {
    throw new CommentBodyTooLongError(MAX_COMMENT_BODY_LEN);
  }
  if (!isCommentableShareType(input.shareType)) {
    throw new ShareTypeNotCommentableError(input.shareType);
  }
  if (input.scope === "passage") {
    if (!supportsPassageAnchors(input.shareType)) {
      throw new InvalidScopeForShareTypeError("passage", input.shareType);
    }
    if (!input.anchor) throw new AnchorRequiredError();
    assertValidAnchor(input.anchor);
  } else {
    if (input.anchor) throw new AnchorForbiddenError();
  }
}

function assertValidAnchor(anchor: PassageAnchor): void {
  const s = anchor.selection;
  if (!s) throw new AnchorRequiredError();
  for (const k of ["start_line", "start_col", "end_line", "end_col"] as const) {
    const v = s[k];
    if (!Number.isInteger(v) || v < 0) throw new AnchorRequiredError();
  }
  if (
    s.end_line < s.start_line ||
    (s.end_line === s.start_line && s.end_col < s.start_col)
  ) {
    throw new AnchorRequiredError();
  }
  if (typeof s.quoted_text !== "string" || s.quoted_text.length === 0) {
    throw new AnchorRequiredError();
  }
}
