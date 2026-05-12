# X1A-9 — Session + share visibility audit

Date: 2026-05-11
Ticket: https://linear.app/x1agent/issue/X1A-9

## Goal

Map every list/get endpoint that returns sessions, share metadata, or
share file content, and confirm each one filters strictly by what the
caller is allowed to see.

## Visibility model (current code, today)

A session is visible to actor `U` in workspace `W` when:

1. `session.agent.workspace_id = W` (always required — cross-tenant guard), **and**
2. one of:
   - `U` is workspace admin/owner, **or**
   - `session.triggered_by_user_id = U` (owner), **or**
   - a row exists in `session_user_shares` with `(session_id = session.id, user_id = U)`.

Future extension (X1A-9 leaves shape, defers behaviour): visible also
when a row exists in a future `session_group_shares` table where one
of `U`'s groups matches. The new helper is shaped so this is an
additive `OR` clause.

## Endpoint map

Routes are mounted in `packages/api/src/index.ts`. The audit ignores
write-paths that already gate on workspace-admin (e.g. `_bulk-delete`,
share-grant POST) — those aren't in scope.

| # | Method + path | Source | Pre-fix scoping | Post-fix scoping |
|---|---|---|---|---|
| 1 | `GET /api/workspaces/:slug/agents/:agentId/sessions` | `domains/sessions/.../routes.ts` createSessionRoutes | admin-only (`listSessions` → `assertAdmin`) | Unchanged — agent-scoped page is admin-only by design; UI uses workspace-scoped list. Documented. |
| 2 | `GET /api/workspaces/:slug/agents/:agentId/sessions/:sessionId` | same | admin-only | Unchanged (same reason). |
| 3 | `GET /api/workspaces/:slug/agents/:agentId/sessions/:sessionId/events` | same | admin-only | Unchanged. |
| 4 | `GET /api/workspaces/:slug/sessions` | createWorkspaceSessionRoutes | admin → `listByWorkspace`; non-admin → `listForUser` (owner ∪ sharee). Correct. | Routed through `pickSessionListMode`. Same SQL, single decision-point. |
| 5 | `GET /api/workspaces/:slug/sessions/:sessionId` | createWorkspaceSessionRoutes (`loadScoped`) | owner ∪ admin ∪ sharee. Correct. | Routed through `resolveSessionVisibility`. |
| 6 | `GET /api/workspaces/:slug/sessions/:sessionId/events` | same | owner ∪ admin ∪ sharee. Correct. | Same. |
| 7 | `POST /api/workspaces/:slug/sessions/:sessionId/resume` | same | owner ∪ admin ∪ sharee. Correct. | Same. |
| 8 | `GET /api/workspaces/:slug/sessions/:sessionId/shares` (per-session share list) | `packages/api/src/shares/routes.ts` createWorkspaceShareRoutes | **admin-only** ⚠ — owner of their own session cannot list their own shares. | Owner ∪ admin ∪ sharee. |
| 9 | `GET /api/workspaces/:slug/sessions/:sessionId/shares/:shareId/*` (share file proxy) | same | **admin-only** ⚠ — owner cannot fetch their own share artefact through the API. | Owner ∪ admin ∪ sharee. |
| 10 | `GET /api/workspaces/:slug/shares` (workspace shares index — the "Shares screen") | `packages/api/src/shares/routes.ts` createWorkspaceSharesIndexRoutes | **admin-only** ⚠ — non-admin members see an empty page even for sessions they own. | Admin → unfiltered. Non-admin → only shares from sessions visible to them. |
| 11 | `GET /api/workspaces/:slug/sessions/:sessionId/user-shares` (share-grant list) | `domains/sessions/.../share-routes.ts` createSessionShareRoutes | owner ∪ admin. Correct. | Unchanged. |

The three flagged rows (#8, #9, #10) are the substance of the ticket —
the Shares screen and per-session share endpoints had been gated to
workspace admins, but the workspace-level session list and detail
already allowed owner + sharee. The asymmetry meant a non-admin
session-owner could see their session's events but not the artefacts
that session emitted. After this change the three surfaces all use one
visibility primitive.

## Domain shape after the fix

```
packages/domains/sessions/src/application/session-visibility.ts
├── resolveSessionVisibility(deps, actor, session, workspaceId)
│     → { visible: true, reason: 'owner'|'workspace_admin'|'user_share' }
│     │   | { visible: false }
│     Used by every per-resource `loadScoped` helper. The agent must
│     already be confirmed in-workspace by the caller. Extension point:
│     add another `OR` clause for group-based shares.
│
└── pickSessionListMode(deps, actor, workspaceId)
      → { mode: 'all' } | { mode: 'user', userId }
      Used by every list endpoint to decide which SQL branch to take.
      Admin path returns 'all' (unfiltered); everyone else gets the
      user-scoped query.
```

Three callers use the helper:

- `createWorkspaceSessionRoutes` (sessions domain) — `loadScoped` +
  list mode.
- `createWorkspaceShareRoutes` (api/shares) — `loadScoped` for the
  per-session share list and file proxy.
- `createWorkspaceSharesIndexRoutes` (api/shares) — list mode picks
  one of two SQL queries.

Performance: no per-row N+1 introduced. The non-admin shares-index
query uses a `LEFT JOIN session_user_shares ON (session_id, user_id)`
exactly like the existing `listForUser` for sessions; the join is on
the `UNIQUE (session_id, user_id)` index so it cannot fan out.

## Test coverage added

- Unit tests for `resolveSessionVisibility` and `pickSessionListMode`
  in `packages/domains/sessions/src/application/session-visibility.test.ts`.
- Per-session share routes (`packages/api/src/shares/share-routes-visibility.test.ts`):
  owner sees, non-owner blocked, cross-workspace blocked, sharee sees.
- Workspace shares index (same file): admin sees all, non-admin sees
  only own + shared, cross-workspace blocked, sharee sees.
- Workspace-scoped session list + detail
  (`packages/api/src/sessions-visibility.integration.test.ts`):
  the same matrix for `GET /api/workspaces/:slug/sessions` and
  `GET /api/workspaces/:slug/sessions/:sessionId`.

## Out of scope (deferred)

- Group-based sharing — shape supported; not implemented.
- Agent-scoped session endpoints (#1–#3) — still admin-only by
  intentional design; UI does not surface them to non-admins.
- UI empty-state copy on `/workspaces/:slug/shares` — separate ticket
  if needed.
