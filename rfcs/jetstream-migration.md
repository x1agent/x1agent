# RFC: NATS JetStream migration

Status: draft. Local POC running on OrbStack as of 2026-05-09.

## Why

Today every cross-component message — wake injections, audit records, raw event stream, presence heartbeats — flows over NATS-core pub/sub. NATS-core is at-most-once: if the publisher and the subscriber aren't both healthy at the moment of publish, the message is gone. This is the root cause behind the Wave-2 freeze on 2026-05-08: three workers lost their NATS connection mid-tool-call when OrbStack paused under sleep, and never picked up the wakes that would have unstuck them.

JetStream layers durable, replayable subjects on top of the same connection and the same subject space. Publishers don't change semantics, but their messages now land on disk; subscribers can consume from a named position (last-ack, sequence, time) instead of "whatever happens to arrive while I'm listening". That's the substrate every other reliability layer in the roadmap (stuck-tool detector, MCP enumeration, server-side wake reconciler) implicitly assumes — without it, those layers are bandaids over an at-most-once bus.

Side benefits we get for free:

- **Forensic replay.** `nats stream view` of the last 24h of `x1.session.>` is a flight recorder for every session that ran. Today you have to scrape pod logs.
- **Preview-environment durability.** Preview pods come and go on cluster churn; without JetStream, any wake destined for a preview that was rolling lost in transit.
- **Decoupled provider deploys.** A provider can restart, miss 30s of traffic, and resume from the last sequence it ack'd. Today a restart drops in-flight messages.

## State after this RFC's prerequisite POC

`deploy/k8s/dev/nats.yaml` enables JetStream with a 2 GiB PVC mounted at `/data` and a single stream `X1_SESSION` covering `x1.session.>`. Verified durable across a pod restart. Existing NATS-core publishers continue to work unchanged — JetStream auto-captures messages that match the stream's subject filter, with no publisher API change. No consumer code uses JetStream yet; this RFC is the cutover plan.

```
Stream:    X1_SESSION
Subjects:  x1.session.>
Storage:   File, /data/jetstream
Retention: Limits, max_age=24h, max_bytes=128MB, discard old
Replicas:  1 (dev only — chart will template by replica count)
Dedupe:    2m
```

## Subject inventory

The four `x1.session.*` subjects in use today:

| Subject | Publisher | Subscriber | Loss tolerance |
|---|---|---|---|
| `x1.session.{id}.input` | `packages/api/src/orchestration/wake-publisher.ts`, `packages/sidecar/src/orchestration.rs` | `packages/sidecar/src/channel.rs` (POSTs to agent `/inject`) | **None.** A dropped wake = stuck session. |
| `x1.session.{id}.events` | `packages/sidecar/src/nats_bridge.rs` (mirrors agent SDK events) | api browser-fanout, future archiver | Tolerable on browser fanout (live UI), not tolerable on archiver. |
| `x1.session.{id}.audit` | `packages/sidecar/src/audit.rs` (every credential-proxied call) | future audit sink | **None.** Audit gaps are a compliance hole. |
| `x1.session.{id}.presence` | `packages/sidecar/src/channel.rs` (~2s heartbeat) | api liveness checker | High. Heartbeats are inherently lossy and re-sent. |

Two subjects are load-bearing under at-least-once: `*.input` and `*.audit`. `*.events` is mixed — the live viewer doesn't need durability, the archiver does. `*.presence` doesn't need durability; it's already idempotent.

## Cutover plan

Three waves, each independently shippable. Each wave can be reverted at the publisher with a one-line flag (`USE_JETSTREAM_PUBLISH=false`) so the cluster never goes through a one-shot migration.

### Wave 1 — `x1.session.*.input` (wakes)

The deepest pain point and the simplest cutover.

**Publisher side (api):**
- Add a `JetStreamPublisher` adapter alongside the existing `NatsPublisher` in `packages/api/src/orchestration/`. It calls `js.publish(subject, payload, { msgID })` with `msgID = wake_id` so the 2-min dedupe window protects against publisher-side retries.
- `wake-publisher.ts` switches to the JetStream variant. Composition root chooses adapter via env (`USE_JETSTREAM_PUBLISH=true`) so revert is one redeploy.

**Consumer side (sidecar):**
- New durable consumer per session: name `wake-{session_id}`, filter subject `x1.session.{id}.input`, ack policy explicit, max-deliver 5, ack-wait 30s. Created on session start, deleted on session reaping.
- `channel.rs` switches from `nats.subscribe(subject)` to `js.consumer("X1_SESSION", "wake-{id}").consume()`. Each message is `ack()`'d only after a successful POST to agent `/inject`.

**Acceptance criteria:**
- A wake published while the sidecar is restarting is delivered after restart (replay).
- A wake delivered to an agent that returns 5xx on `/inject` is redelivered up to 5 times before going to a dead-letter consumer.
- Two operator-spawned wakes published 100ms apart with the same `msgID` only inject once (dedup).

### Wave 2 — `x1.session.*.audit` (compliance)

**Publisher side (sidecar Rust):**
- Replace `nc.publish(subject, payload).await?` in `audit.rs` with `js.publish(subject, payload).await?`. The async-nats crate exposes JetStream context off the same `Client`. msg-id = audit record uuid for dedup.

**Consumer side:**
- New consumer `audit-archiver` (durable, push or pull, ack-explicit). Archives to Postgres `audit_events` table (schema TBD). Deferred to a follow-up; until that lands, the stream itself is the audit log, queryable via `nats stream view`.

**Acceptance criteria:**
- Restart the sidecar mid-tool-call: the audit record for the in-flight call arrives exactly once.

### Wave 3 — `x1.session.*.events` (split)

This subject has two consumers with different needs. The path of least resistance is to split it:

- `x1.session.{id}.events` — keep on NATS-core, browser viewer subscribes here (no replay, no durability — live tail only).
- `x1.session.{id}.archive` — new subject, JetStream-captured, sidecar publishes the same payload. Archiver consumes from JetStream, browser ignores.

The alternative — having the browser pull from JetStream via WebSocket gateway — needs the WebSocket gateway to negotiate JetStream consumer state per browser connection, which is a bigger change. Defer.

`*.presence` stays on NATS-core indefinitely. JetStream-capturing presence heartbeats wastes 1 GiB of disk a week with no replay value.

## Stream-shape decisions

These are decisions made for the dev POC that customers will need to override in Helm:

| Decision | Dev POC | Helm production default | Rationale |
|---|---|---|---|
| Replicas | 1 | 3 | Single-replica is data-loss on node failure. Prod must run 3 replicas of NATS so JetStream RAFT can quorum. |
| Storage | 2 GiB PVC | 50 GiB+ PVC, customer-tunable | Audit + 30-day session history at scale. |
| `max_age` | 24h | 30d (`x1.session.*.audit`), 24h (others) | Audit retention is the compliance answer. |
| `max_bytes` | 128 MiB | unlimited (`audit`), 1 GiB (`input`/`events`) | Audit records can't be dropped silently. |
| `discard` policy | old | **`new`** for audit | Dropping old audit records is unacceptable. Dropping new audit records is also unacceptable but at least it's loud — it surfaces back-pressure as publish errors that a publisher can react to. |

Helm chart change: split `X1_SESSION` into per-purpose streams (`X1_SESSION_INPUT`, `X1_SESSION_AUDIT`, `X1_SESSION_ARCHIVE`) so each can have its own retention. The single-stream POC is fine for dev; one stream per durability profile is the right shape at scale. This change is local to chart templates — publishers/consumers reference stream names via env, not literals.

## Risk + decisions deferred

- **No JetStream for cross-cluster replication yet.** Single-cluster only. JetStream supports source/mirror replication across clusters; not needed until we run multi-region.
- **No leader-elected consumer.** A durable consumer with multiple sidecars subscribed acts as a queue group; ordering across competing consumers is a per-subject FIFO, not a per-stream FIFO. For wakes, ordering doesn't matter (each wake targets one session). For audit, single archiver is fine. Reassess if we add fan-out consumers.
- **Publishers don't currently get back-pressure from publish failures.** When `discard=new` and the stream is full, JetStream returns `MaxBytesError`. Publishers must surface this as a 503 to the caller, not swallow it. Add a metric and an alert with the cutover.
- **Consumer storage cost.** Each session creates a durable consumer, which costs metadata. At ~100 active sessions/cluster this is fine; at 10k+ we may need ephemeral consumers (auto-deleted on disconnect) for `*.events` and durable only for `*.input`.

## Success criteria for the migration as a whole

When all three waves are done:

1. Killing the NATS pod for 60s and restoring it does not lose any `x1.session.*.input` wake.
2. A worker pod that pauses for 30 minutes (sleep, network partition) catches up on every wake addressed to it on resume — none silently dropped.
3. The `audit_events` table has a row for every credential-proxy call observed in the corresponding pod's stderr.
4. `mise run install` on a fresh GKE cluster brings up JetStream with the right stream definitions; no manual `nats stream add` step.
5. `docs/architecture/` documents the per-subject durability profile and the cutover history. The architecture is binding (per CLAUDE.md), so the docs need to lead this change, not lag it.

## Out of scope

- Anything other than the four subjects listed in the inventory. New subjects added after this RFC must declare their durability profile in the same table.
- Browser-side JetStream consumption (still NATS-core via WebSocket gateway).
- Replacing the existing audit-record storage path (none yet — archiver is in scope of Wave 2's follow-up, not this RFC).
- Layer 4 (stuck-tool detector), Layer 2 (MCP enumeration), Layer 3 (wake reconciler) — those are separate roadmap items that build *on top of* this substrate.
