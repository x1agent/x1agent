use crate::AppState;
use async_nats::jetstream::{self, consumer::pull::Config as PullConfig, AckKind};
use async_nats::HeaderMap;
use bytes::Bytes;
use futures_util::StreamExt;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;

/// Mirror of api side `publishInputEnvelope` in
/// packages/api/src/orchestration/wake-publisher.ts. When
/// USE_JETSTREAM_PUBLISH=true the publish goes through JetStream with
/// a Nats-Msg-Id header so the broker's duplicate window absorbs
/// publisher-side retries; otherwise it falls back to NATS-core. The
/// flag is process-level so the cutover is reversible per pod.
pub async fn publish_with_dedup(
    nc: &async_nats::Client,
    subject: String,
    payload: Bytes,
    msg_id: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if std::env::var("USE_JETSTREAM_PUBLISH").as_deref() == Ok("true") {
        let js = jetstream::new(nc.clone());
        let mut headers = HeaderMap::new();
        headers.insert("Nats-Msg-Id", msg_id);
        js.publish_with_headers(subject, headers, payload)
            .await?
            .await?;
        return Ok(());
    }
    nc.publish(subject, payload).await?;
    Ok(())
}

/// Wake publishes from the sidecar (today: orchestrator's
/// `inject_message` MCP tool routed through handle_inject_child) go
/// through this helper so the publish path matches the api side.
/// Without it, Wave 1 would have a wake-loss hole on orchestrator →
/// child spawn that the api fix doesn't cover.
pub async fn publish_input_envelope(
    nc: &async_nats::Client,
    target_session_id: &str,
    payload: Bytes,
    msg_id: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    publish_with_dedup(
        nc,
        format!("x1.session.{}.input", target_session_id),
        payload,
        msg_id,
    )
    .await
}

#[derive(Serialize)]
struct InjectPayload {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    // X1A-103 — wake-classification fields forwarded to the agent so
    // it can emit `session.agent_thinking` with the right payload
    // (event_id for correlation, share_id/thread_id for share-comment
    // wake routing). All optional: a publisher that doesn't stamp
    // them gets sensible fallbacks on the agent side.
    #[serde(skip_serializing_if = "Option::is_none")]
    event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wake_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    share_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    // X1A-133 — SDK-native wake-classification envelope (PRD 0007).
    // `origin.kind` discriminates the wake category (channel / peer /
    // coordinator / task-notification). `is_synthetic` flags server-
    // synthesised wakes (vs human-typed). `priority` and
    // `should_query` carry forward-compatible plumbing — current
    // share-comments slice uses normal/true, future slices toggle.
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_synthetic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    priority: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    should_query: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedInput {
    pub text: String,
    pub sender_id: Option<String>,
    pub request_id: Option<String>,
    pub sequence: u64,
    // X1A-103 fields. Same nullable semantics as in InjectPayload.
    pub event_id: Option<String>,
    pub wake_source: Option<String>,
    pub share_id: Option<String>,
    pub thread_id: Option<String>,
    pub kind: Option<String>,
    pub source: Option<String>,
    // X1A-133 — forward-compatible SDK-native wake envelope (PRD 0007).
    pub origin: Option<serde_json::Value>,
    pub is_synthetic: Option<bool>,
    pub priority: Option<String>,
    pub should_query: Option<bool>,
}

/// Parse the user-input NATS message, preferring `text` over `answer`
/// (reply to a request_input carries `answer`).
pub fn parse_input_message(raw: &[u8]) -> Option<ParsedInput> {
    let message: serde_json::Value = serde_json::from_slice(raw).ok()?;
    let payload = message.get("payload")?;
    let text = payload
        .get("text")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("answer").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let sender_id = payload
        .get("sender_id")
        .and_then(|v| v.as_str())
        .map(String::from);
    let request_id = payload
        .get("request_id")
        .and_then(|v| v.as_str())
        .map(String::from);
    let sequence = message.get("sequence").and_then(|v| v.as_u64()).unwrap_or(0);
    let str_field = |name: &str| {
        payload
            .get(name)
            .and_then(|v| v.as_str())
            .map(String::from)
    };
    Some(ParsedInput {
        text,
        sender_id,
        request_id,
        sequence,
        event_id: str_field("event_id"),
        wake_source: str_field("wake_source"),
        share_id: str_field("share_id"),
        thread_id: str_field("thread_id"),
        kind: str_field("kind"),
        source: str_field("source"),
        origin: payload.get("origin").cloned(),
        is_synthetic: payload.get("is_synthetic").and_then(|v| v.as_bool()),
        priority: str_field("priority"),
        should_query: payload.get("should_query").and_then(|v| v.as_bool()),
    })
}

/// Wait for the agent container's HTTP server to come up before we
/// start consuming wake messages — otherwise the first wake races the
/// agent's bind and gets dropped on the floor (or, on the JetStream
/// path, naks five times and goes to dead-letter).
async fn wait_for_agent_ready(client: &reqwest::Client, channel_url: &str) -> bool {
    let health_url = format!("{}/health", channel_url);
    for attempt in 1..=60_u32 {
        match client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => return true,
            _ => {
                if attempt == 60 {
                    tracing::error!("Agent inject endpoint never became ready");
                    return false;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    false
}

/// X1A-63 — handle a parent_staging input message by fetching each
/// staged file from the api and materializing it into
/// `/workspace/{dest_path}/...`. Returns Ok(()) when the bytes are
/// written so the caller can ack and SUPPRESS the /inject forward —
/// the agent doesn't see the wake as a user message; from its POV,
/// files just appeared. Errors bubble so JetStream redelivers.
async fn handle_parent_staging(
    state: &Arc<crate::AppState>,
    client: &reqwest::Client,
    payload: &[u8],
) -> Result<(), String> {
    let message: serde_json::Value = serde_json::from_slice(payload)
        .map_err(|e| format!("parent_staging: bad envelope: {e}"))?;
    let p = message.get("payload").ok_or("parent_staging: no payload")?;
    let stage_id = p
        .get("stage_id")
        .and_then(|v| v.as_str())
        .ok_or("parent_staging: missing stage_id")?;
    let dest_path = p
        .get("dest_path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let paths: Vec<String> = p
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if paths.is_empty() {
        return Err("parent_staging: empty paths".into());
    }

    // Resolve dest_path against /workspace. The parent supplied dest;
    // refuse traversal here even though the api enforced it on the
    // parent side — defense in depth, the sidecar is the trust
    // boundary for filesystem writes.
    let dest_rel = crate::shares::normalize_request_path(&dest_path)
        .map_err(|e| format!("parent_staging: invalid dest_path: {e}"))?;
    let dest_root = std::path::PathBuf::from("/workspace").join(&dest_rel);

    for rel in &paths {
        // Refuse `..` in individual file paths the same way. Each rel
        // gets joined onto dest_root so a per-file traversal would
        // also need a leading `../`, which normalize rejects.
        let safe_rel = crate::shares::normalize_request_path(rel)
            .map_err(|e| format!("parent_staging: invalid file path {rel}: {e}"))?;

        let url = format!(
            "{}/api/internal/sessions/{}/staging/{}/content?path={}",
            state.api_url.trim_end_matches('/'),
            state.session_id,
            urlencoding::encode(stage_id),
            urlencoding::encode(&safe_rel),
        );
        let resp = client
            .get(&url)
            .header("X-Internal-Token", &state.api_internal_token)
            .send()
            .await
            .map_err(|e| format!("parent_staging: fetch {rel}: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "parent_staging: fetch {rel}: status {}",
                resp.status()
            ));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("parent_staging: parse {rel}: {e}"))?;
        let b64 = body
            .get("content_b64")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("parent_staging: no content_b64 for {rel}"))?;
        let bytes = base64_decode(b64)
            .ok_or_else(|| format!("parent_staging: bad base64 for {rel}"))?;

        // Decide on-disk path. When a single file is staged with a
        // dest_path of "inputs/spec.md", we write directly to that
        // path (don't append the source basename). When multiple
        // files are staged, dest_path is a directory and we preserve
        // the relative file paths under it.
        let target = if paths.len() == 1 {
            dest_root.clone()
        } else {
            dest_root.join(&safe_rel)
        };
        if let Some(parent_dir) = target.parent() {
            std::fs::create_dir_all(parent_dir)
                .map_err(|e| format!("parent_staging: mkdir {rel}: {e}"))?;
        }
        // Canonicalize the PARENT directory (target may not exist yet)
        // and re-confirm it lives under /workspace. Without this, a
        // crafted dest_path that resolves through a symlink could
        // escape the volume.
        let parent_canonical = target
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .ok_or_else(|| format!("parent_staging: bad target {rel}"))?;
        if !parent_canonical.starts_with("/workspace") {
            return Err("parent_staging: target outside /workspace".into());
        }
        std::fs::write(&target, &bytes)
            .map_err(|e| format!("parent_staging: write {rel}: {e}"))?;
    }
    tracing::info!(
        "parent_staging: materialized {} files at /workspace/{}",
        paths.len(),
        dest_rel
    );
    Ok(())
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    // Hand-rolled to keep the binary surface small — mirrors the
    // encoder in shares.rs. Tolerates trailing `=` padding.
    let lookup: [Option<u8>; 256] = {
        let mut t: [Option<u8>; 256] = [None; 256];
        for (i, b) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            .iter()
            .enumerate()
        {
            t[*b as usize] = Some(i as u8);
        }
        t
    };
    let cleaned: Vec<u8> = s.bytes().filter(|b| *b != b'=' && *b != b'\n').collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for b in cleaned {
        let v = lookup[b as usize]?;
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Decode + POST one wake to the agent's /inject endpoint. Returns
/// Ok(()) on a successful inject so the JetStream caller can ack the
/// message, Err on parse failure or HTTP failure so the caller can
/// nak and let JetStream redeliver.
async fn post_inject(
    client: &reqwest::Client,
    inject_url: &str,
    payload: &[u8],
) -> Result<(), String> {
    let parsed = parse_input_message(payload)
        .ok_or_else(|| "malformed wake envelope".to_string())?;
    let body = InjectPayload {
        text: parsed.text,
        sender_id: parsed.sender_id,
        request_id: parsed.request_id,
        event_id: parsed.event_id,
        wake_source: parsed.wake_source,
        share_id: parsed.share_id,
        thread_id: parsed.thread_id,
        kind: parsed.kind,
        source: parsed.source,
        origin: parsed.origin,
        is_synthetic: parsed.is_synthetic,
        priority: parsed.priority,
        should_query: parsed.should_query,
    };
    let resp = client
        .post(inject_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("inject http error: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("inject status {}", resp.status()));
    }
    Ok(())
}

/// Pick the consumer path. `USE_JETSTREAM_CONSUME=true` switches from
/// the legacy NATS-core subscription to a per-session durable JetStream
/// consumer with explicit acks. The two paths share the same
/// post-to-/inject logic; only the message source differs. Default
/// stays on the core path so existing pods don't change behaviour at
/// upgrade time.
fn use_jetstream_consume() -> bool {
    matches!(
        std::env::var("USE_JETSTREAM_CONSUME").as_deref(),
        Ok("true")
    )
}

/// `x1.session.{id}.input` → POST to the agent's /inject endpoint.
pub async fn input_subscriber(state: Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    if use_jetstream_consume() {
        return input_subscriber_jetstream(state).await;
    }
    input_subscriber_core(state).await
}

/// Legacy path. NATS-core subscribe — at-most-once. Kept around so
/// the cutover to JetStream can be flipped per-session without a
/// coordinated deploy, and so existing sessions on the upgrade boundary
/// keep working.
async fn input_subscriber_core(
    state: Arc<AppState>,
) -> Result<(), Box<dyn std::error::Error>> {
    let subject = format!("x1.session.{}.input", state.session_id);
    let mut sub = state
        .nc
        .subscribe(async_nats::subject::Subject::from(subject))
        .await?;
    let client = reqwest::Client::new();

    if !wait_for_agent_ready(&client, &state.channel_url).await {
        return Ok(());
    }
    tracing::info!(
        "Subscribed to input (core) for session {}",
        state.session_id
    );

    let inject_url = format!("{}/inject", state.channel_url);

    while let Some(msg) = sub.next().await {
        // X1A-63 — parent_staging messages are materialized to
        // /workspace by the sidecar itself and NOT forwarded to the
        // agent's /inject. The agent finds the files already on disk
        // the next turn; no synthetic user-message in the timeline.
        if is_parent_staging(&msg.payload) {
            match handle_parent_staging(&state, &client, &msg.payload).await {
                Ok(()) => tracing::info!("parent_staging: applied"),
                Err(e) => tracing::error!("parent_staging failed: {}", e),
            }
            continue;
        }
        match post_inject(&client, &inject_url, &msg.payload).await {
            Ok(()) => tracing::info!("Injected message into agent"),
            Err(e) => tracing::error!("Agent inject failed: {}", e),
        }
    }
    Ok(())
}

/// Peek at the payload's `kind` field WITHOUT a full parse — just
/// enough to know whether this is a parent_staging message we should
/// route through the filesystem branch instead of /inject.
fn is_parent_staging(payload: &[u8]) -> bool {
    let v: serde_json::Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(_) => return false,
    };
    v.get("payload")
        .and_then(|p| p.get("kind"))
        .and_then(|k| k.as_str())
        == Some("parent_staging")
}

/// JetStream path. Per-session durable pull consumer reads from the
/// `X1_SESSION` stream filtered to this session's `*.input` subject.
/// Explicit ack means the broker holds the message until we say it's
/// safely injected; ack-wait of 30s means a stuck inject re-delivers;
/// max-deliver of 5 means the same wake won't loop forever if the
/// agent keeps rejecting it. inactive_threshold of 1h auto-cleans the
/// consumer after the session pod is gone — no explicit teardown
/// needed at session-reaping time.
async fn input_subscriber_jetstream(
    state: Arc<AppState>,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    if !wait_for_agent_ready(&client, &state.channel_url).await {
        return Ok(());
    }

    let js = jetstream::new(state.nc.clone());
    let stream = js.get_stream("X1_SESSION").await?;
    let consumer_name = format!("wake-{}", state.session_id);
    let filter_subject = format!("x1.session.{}.input", state.session_id);

    let consumer = stream
        .get_or_create_consumer(
            &consumer_name,
            PullConfig {
                durable_name: Some(consumer_name.clone()),
                filter_subject: filter_subject.clone(),
                ack_policy: jetstream::consumer::AckPolicy::Explicit,
                ack_wait: Duration::from_secs(30),
                max_deliver: 5,
                inactive_threshold: Duration::from_secs(60 * 60),
                ..Default::default()
            },
        )
        .await?;

    tracing::info!(
        "Subscribed to input (jetstream durable consumer={}) for session {}",
        consumer_name,
        state.session_id
    );

    let inject_url = format!("{}/inject", state.channel_url);
    let mut messages = consumer.messages().await?;

    while let Some(maybe_msg) = messages.next().await {
        let msg = match maybe_msg {
            Ok(m) => m,
            Err(e) => {
                tracing::error!("jetstream messages stream error: {}", e);
                continue;
            }
        };

        let info = msg.info().ok();
        let delivery_count = info.as_ref().map(|i| i.delivered).unwrap_or(0);

        // Per-message freshness gate. Publishers stamp `expires_at`
        // (epoch ms) so a message that's been queued past its
        // usefulness window doesn't fire surprise side effects. Stale
        // → ack-and-drop, never inject. Missing `expires_at` is a
        // legacy publisher (pre-Wave-1) — process as-is so a chart
        // upgrade in the middle of a session doesn't lose messages
        // published by an older browser tab still open.
        if let Some(expires_at) = peek_expires_at(&msg.payload) {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if now_ms > expires_at {
                tracing::warn!(
                    "Dropping stale input (expired {}ms ago, delivery={})",
                    now_ms.saturating_sub(expires_at),
                    delivery_count
                );
                if let Err(e) = msg.ack().await {
                    tracing::error!("ack failed on expired: {}", e);
                }
                continue;
            }
        }

        // X1A-63 — parent_staging branch identical to the core path:
        // bypass /inject, materialize bytes into /workspace, ack.
        if is_parent_staging(&msg.payload) {
            match handle_parent_staging(&state, &client, &msg.payload).await {
                Ok(()) => {
                    if let Err(e) = msg.ack().await {
                        tracing::error!("ack failed: {}", e);
                    }
                    tracing::info!(
                        "parent_staging: applied (delivery={})",
                        delivery_count
                    );
                }
                Err(e) => {
                    tracing::error!(
                        "parent_staging failed (delivery={}): {}",
                        delivery_count,
                        e
                    );
                    let backoff = match delivery_count {
                        0 | 1 => Duration::from_secs(2),
                        2 => Duration::from_secs(10),
                        _ => Duration::from_secs(30),
                    };
                    if let Err(e) = msg
                        .ack_with(AckKind::Nak(Some(backoff)))
                        .await
                    {
                        tracing::error!("nak failed: {}", e);
                    }
                }
            }
            continue;
        }
        match post_inject(&client, &inject_url, &msg.payload).await {
            Ok(()) => {
                if let Err(e) = msg.ack().await {
                    tracing::error!("ack failed: {}", e);
                }
                tracing::info!(
                    "Injected message into agent (delivery={})",
                    delivery_count
                );
            }
            Err(e) => {
                tracing::error!(
                    "Agent inject failed (delivery={}): {}",
                    delivery_count,
                    e
                );
                // Nak with backoff so JetStream waits before redelivery.
                let backoff = match delivery_count {
                    0 | 1 => Duration::from_secs(2),
                    2 => Duration::from_secs(10),
                    _ => Duration::from_secs(30),
                };
                if let Err(e) = msg
                    .ack_with(AckKind::Nak(Some(backoff)))
                    .await
                {
                    tracing::error!("nak failed: {}", e);
                }
            }
        }
    }
    Ok(())
}

/// Peek `expires_at` (epoch ms) out of an input envelope WITHOUT a
/// full parse — we only need this one field for the freshness gate.
/// `serde_json::from_slice::<serde_json::Value>` is cheap; the message
/// is small (a few hundred bytes typical). Returns None on missing
/// field, parse failure, or non-numeric value; the caller treats
/// missing as "no TTL set, process normally".
fn peek_expires_at(payload: &Bytes) -> Option<u64> {
    let v: serde_json::Value = serde_json::from_slice(payload).ok()?;
    v.get("expires_at").and_then(|x| x.as_u64())
}

/// `x1.session.{id}.presence` → POST /keepalive on the agent. The agent
/// resets its idle timer so sessions stay alive while someone watches.
pub async fn presence_subscriber(state: Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    let subject = format!("x1.session.{}.presence", state.session_id);
    let mut sub = state
        .nc
        .subscribe(async_nats::subject::Subject::from(subject))
        .await?;
    let keepalive_url = format!("{}/keepalive", state.channel_url);
    let client = reqwest::Client::new();
    tracing::info!("Subscribed to presence for session {}", state.session_id);
    while let Some(_msg) = sub.next().await {
        let url = keepalive_url.clone();
        let c = client.clone();
        tokio::spawn(async move {
            let _ = c.post(&url).send().await;
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_input_basic_text() {
        let raw = br#"{"sequence":5,"payload":{"text":"hello"}}"#;
        let p = parse_input_message(raw).unwrap();
        assert_eq!(p.text, "hello");
        assert_eq!(p.sequence, 5);
        assert!(p.sender_id.is_none());
    }

    #[test]
    fn parse_input_uses_answer_field_for_input_response() {
        let raw = br#"{"payload":{"answer":"yes","request_id":"q1"}}"#;
        let p = parse_input_message(raw).unwrap();
        assert_eq!(p.text, "yes");
        assert_eq!(p.request_id.as_deref(), Some("q1"));
    }

    #[test]
    fn parse_input_prefers_text_over_answer() {
        let raw = br#"{"payload":{"text":"primary","answer":"fallback"}}"#;
        let p = parse_input_message(raw).unwrap();
        assert_eq!(p.text, "primary");
    }

    #[test]
    fn parse_input_returns_none_for_missing_payload() {
        let raw = br#"{"sequence":1}"#;
        assert!(parse_input_message(raw).is_none());
    }

    #[test]
    fn parse_input_returns_none_for_invalid_json() {
        assert!(parse_input_message(b"not-json").is_none());
    }

    // X1A-103 — wake-classification fields the agent uses to emit
    // session.agent_thinking. Optional on the wire; absent = "user
    // wake from a legacy publisher."

    #[test]
    fn parse_input_extracts_event_id_and_wake_source() {
        let raw = br#"{"payload":{"text":"hi","event_id":"evt-1","wake_source":"user"}}"#;
        let p = parse_input_message(raw).unwrap();
        assert_eq!(p.event_id.as_deref(), Some("evt-1"));
        assert_eq!(p.wake_source.as_deref(), Some("user"));
    }

    #[test]
    fn parse_input_extracts_share_comment_routing_fields() {
        let raw = br#"{"payload":{"text":"hi","kind":"comment_added","share_id":"s-1","thread_id":"t-1","source":"platform","event_id":"comment-1"}}"#;
        let p = parse_input_message(raw).unwrap();
        assert_eq!(p.kind.as_deref(), Some("comment_added"));
        assert_eq!(p.share_id.as_deref(), Some("s-1"));
        assert_eq!(p.thread_id.as_deref(), Some("t-1"));
        assert_eq!(p.source.as_deref(), Some("platform"));
        assert_eq!(p.event_id.as_deref(), Some("comment-1"));
    }

    #[test]
    fn parse_input_legacy_publisher_leaves_wake_fields_none() {
        // Pre-X1A-103 envelope shape — the agent will derive
        // wake_source=user and mint a fresh event_id.
        let raw = br#"{"payload":{"text":"hello"}}"#;
        let p = parse_input_message(raw).unwrap();
        assert!(p.event_id.is_none());
        assert!(p.wake_source.is_none());
        assert!(p.kind.is_none());
        assert!(p.share_id.is_none());
        assert!(p.thread_id.is_none());
        assert!(p.origin.is_none());
        assert!(p.is_synthetic.is_none());
        assert!(p.priority.is_none());
        assert!(p.should_query.is_none());
    }

    // X1A-133 — SDK-native wake envelope fields (PRD 0007). The
    // sidecar must forward `origin`, `is_synthetic`, `priority`, and
    // `should_query` verbatim so the agent can classify the wake
    // without parsing the prose body.
    #[test]
    fn parse_input_extracts_pr_0007_origin_envelope() {
        let raw = br#"{"payload":{"text":"hi","origin":{"kind":"channel","server":"share-comments","share_id":"s","thread_id":"t"},"is_synthetic":true,"priority":"normal","should_query":true}}"#;
        let p = parse_input_message(raw).unwrap();
        assert_eq!(
            p.origin
                .as_ref()
                .and_then(|v| v.get("kind"))
                .and_then(|v| v.as_str()),
            Some("channel"),
        );
        assert_eq!(
            p.origin
                .as_ref()
                .and_then(|v| v.get("server"))
                .and_then(|v| v.as_str()),
            Some("share-comments"),
        );
        assert_eq!(p.is_synthetic, Some(true));
        assert_eq!(p.priority.as_deref(), Some("normal"));
        assert_eq!(p.should_query, Some(true));
    }
}
