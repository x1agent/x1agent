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
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedInput {
    pub text: String,
    pub sender_id: Option<String>,
    pub request_id: Option<String>,
    pub sequence: u64,
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
    Some(ParsedInput {
        text,
        sender_id,
        request_id,
        sequence,
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
        match post_inject(&client, &inject_url, &msg.payload).await {
            Ok(()) => tracing::info!("Injected message into agent"),
            Err(e) => tracing::error!("Agent inject failed: {}", e),
        }
    }
    Ok(())
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
}
