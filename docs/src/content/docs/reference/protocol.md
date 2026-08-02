---
title: Message Protocol
description: X1Message envelope format and event types
sidebar:
  order: 1
---

All messages on NATS use a standard envelope:

```ts
interface SessionMessage {
  session_id: string
  timestamp: string      // ISO 8601
  sequence: number       // monotonic per session
  type: string           // event type discriminator
  payload: unknown       // typically an object; can be any JSON value.
                         // Per-type schemas are documented per event below.
}
```

`sequence` is allocated by the sidecar via an atomic counter; consumers
(api subscriber, browser tail) dedup on `(session_id, sequence)` because the
counter resets to 0 if the sidecar restarts mid-session.

## NATS subjects

| Subject | Direction | Notes |
| --- | --- | --- |
| `x1.session.{id}.events` | sidecar → api/browser | Live event stream from the agent's SSE bridge. |
| `x1.session.{id}.input` | api → sidecar | User input + orchestrator wake messages. |
| `x1.session.{id}.audit` | sidecar → api | Sidecar HTTP-handler audit trail. |
| `x1.session.{id}.archive` | sidecar → JetStream | Durable copy of `events`, when `useJetstreamPublish=true` (Wave 3 of `rfcs/jetstream-migration.md`). |
| `x1.session.{id}.presence` | api → sidecar | Liveness pokes; sidecar POSTs `/keepalive` on the agent. |
| `x1.provider.{domain}.*` | sidecar → provider | Request/reply for graph/vector/messaging/calendar/docs/email/files. |
| `x1.provider.preview.provision` | api → preview provider | |
| `x1.image.build` | api/api-internal → in-process image-builder | Workspace image build trigger. |
| `x1.audit.>` | provider → api | Provider-side audit publishes. |
| `x1.orchestration.>` | api → orchestrator children | Reserved per NATS ACL; in flight. |

There is **no** `x1.session.{id}.proxy.*` or `x1.session.{id}.lifecycle.*` family today; the credential-proxy uses HTTP between agent and sidecar, and lifecycle events ride the `events` subject as `type: session.started/completed/failed`.

## Event types

### Session lifecycle (on `events`)

| Type | Payload | Description |
|------|---------|-------------|
| `session.started` | `{ agent_id, session_id, ... }` | Posted once by the agent on boot. See the runtime driver under `packages/agent-claude` or `packages/agent-codex`. |
| `session.completed` | `{ ... }` | Posted once at clean shutdown. The session summary is computed by the api summarizer and stored in `sessions.summary` — it is **not** carried in the event payload. |
| `session.failed` | `{ error_message? }` | Posted on failure paths. |

### Agent output

| Type | Payload | Description |
|------|---------|-------------|
| `agent.thinking` | `{ text }` | Extended thinking content |
| `agent.text` | `{ text }` | Text output from the agent |
| `agent.tool_call` | `{ tool, params }` | Agent is calling a tool |
| `agent.tool_result` | `{ tool, result }` | Tool returned a non-error result |
| `agent.tool_error` | `{ tool, ... }` | Tool returned an error |
| `agent.input_request` | `{ ... }` | Agent is asking the user for input |
| `agent.usage` | `{ ... }` | Token usage report (one per turn) |

### Proactive emission

| Type | Payload | Description |
|------|---------|-------------|
| `agent.status` | `{ message }` | Status update for the UI |
| `agent.artifact` | `{ type, data, ... }` | Structured output (table, chart, file) |
| `agent.share` | (share metadata) | A shared artifact was created. The api's `/api/workspaces/:slug/sessions/:id/shares` route is the system of record. |
| `agent.permission_request` | `{ scopes, justification }` | Agent asked the user to grant a scope. The grant flow itself is HTTP, not a wire event. |

### User interaction

| Type | Payload | Description |
|------|---------|-------------|
| `user.message` | `{ text, user_id? }` | User input |
| `user.input_response` | `{ text, request_id }` | Reply to a prior `agent.input_request` |

The previous draft of this page documented `permission.request`/`permission.grant` events with `challenge_id`/`approval_token` fields. Those do not exist in v1 — the agent emits `agent.permission_request`, the user grants/denies via the api's HTTP grant routes (`/api/workspaces/:slug/grants`), and a synthetic `user.message` re-wakes the agent.
