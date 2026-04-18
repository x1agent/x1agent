---
title: Message Protocol
description: X1Message envelope format and event types
sidebar:
  order: 1
---

All messages on NATS use a standard envelope:

```typescript
interface X1Message {
  session_id: string
  timestamp: string      // ISO 8601
  sequence: number       // monotonic per session
  type: string           // event type discriminator
  payload: Record<string, unknown>
}
```

## NATS subjects

```
x1.session.{session_id}.events      sidecar publishes, clients subscribe
x1.session.{session_id}.input       clients publish, sidecar subscribes
x1.session.{session_id}.proxy.*     credential proxy requests

x1.provider.{domain}.*              provider request/reply
x1.session.{id}.lifecycle.*         session lifecycle events
```

## Event types

### Session lifecycle

| Type | Payload | Description |
|------|---------|-------------|
| `session.started` | `{ agent_id }` | Session pod is running |
| `session.completed` | `{ summary }` | Session finished normally |
| `session.failed` | `{ error }` | Session errored |

### Agent output

| Type | Payload | Description |
|------|---------|-------------|
| `agent.thinking` | `{ text }` | Extended thinking content |
| `agent.text` | `{ text }` | Text output from the agent |
| `agent.tool_call` | `{ tool, params }` | Agent is calling a tool |
| `agent.tool_result` | `{ tool, result }` | Tool returned a result |

### Proactive emission

| Type | Payload | Description |
|------|---------|-------------|
| `agent.status` | `{ message }` | Status update for the UI |
| `agent.artifact` | `{ type, data }` | Structured output (table, chart, file) |
| `agent.share` | `{ url }` | Shareable link to session output |

### User interaction

| Type | Payload | Description |
|------|---------|-------------|
| `user.message` | `{ text, user_id }` | User input |
| `permission.request` | `{ scopes, challenge_id }` | Permission consent request |
| `permission.grant` | `{ scopes, approval_token }` | User approved scopes |
