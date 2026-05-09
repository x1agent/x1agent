use crate::channel::publish_with_dedup;
use crate::{AppState, SessionMessage};
use async_nats::{Client as NatsClient, ConnectOptions};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// Build connect options. When NATS_CLIENT_CERT, NATS_CLIENT_KEY, and
/// NATS_CA_FILE are all set, the sidecar speaks mTLS and presents its
/// client cert; the NATS server's `verify: true` setting drops any
/// peer that doesn't. Without those env vars we fall back to plain
/// TCP — only valid for one-shot tests outside a cluster.
fn build_options() -> ConnectOptions {
    let cert = std::env::var("NATS_CLIENT_CERT").ok();
    let key = std::env::var("NATS_CLIENT_KEY").ok();
    let ca = std::env::var("NATS_CA_FILE").ok();
    match (cert, key, ca) {
        (Some(cert), Some(key), Some(ca)) => ConnectOptions::new()
            .require_tls(true)
            .add_root_certificates(PathBuf::from(ca))
            .add_client_certificate(PathBuf::from(cert), PathBuf::from(key)),
        _ => ConnectOptions::new(),
    }
}

/// Connect to NATS with retries. Sidecar starts before NATS may be
/// ready in the same pod/cluster; a small retry loop hides that race.
pub async fn connect_with_retry(url: &str, max_retries: u32) -> NatsClient {
    for attempt in 1..=max_retries {
        match build_options().connect(url).await {
            Ok(nc) => return nc,
            Err(e) => {
                tracing::warn!("NATS connect attempt {}/{}: {}", attempt, max_retries, e);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
    panic!("Failed to connect to NATS after {} attempts", max_retries);
}

pub fn build_message(
    session_id: &str,
    event_type: &str,
    payload: serde_json::Value,
    sequence: u64,
) -> SessionMessage {
    SessionMessage {
        session_id: session_id.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        sequence,
        r#type: event_type.to_string(),
        payload,
    }
}

pub fn events_subject(session_id: &str) -> String {
    format!("x1.session.{}.events", session_id)
}

pub fn archive_subject(session_id: &str) -> String {
    format!("x1.session.{}.archive", session_id)
}

/// Wave 3 of rfcs/jetstream-migration.md splits agent SDK events into
/// two subjects with different durability profiles:
///   - `x1.session.{id}.events` -- NATS-core, the live browser tail.
///     Stays as-is so the WebSocket gateway path is unchanged. No
///     replay, no durability; that's the right shape for a live UI.
///   - `x1.session.{id}.archive` -- JetStream-aware (when
///     USE_JETSTREAM_PUBLISH=true), msg-id-deduped, picked up by the
///     forensic archiver consumer (deferred follow-up). Same payload
///     as events; consumers choose which subject matches their needs.
///
/// We keep BOTH publishes on every event so a flag flip is reversible
/// and the browser path is never on JetStream. Doubles per-event
/// publish work and (for now) per-event stream storage; the stream
/// will be tightened to filter `*.events` out in a follow-up chart
/// change once the archiver consumer is in place.
pub async fn publish_event(
    state: &Arc<AppState>,
    event_type: &str,
    payload: serde_json::Value,
) {
    let seq = state.sequence.fetch_add(1, Ordering::Relaxed);
    let message = build_message(&state.session_id, event_type, payload, seq);
    let data = serde_json::to_vec(&message).unwrap_or_default();

    // Live browser tail -- unconditional, NATS-core only.
    let events = events_subject(&state.session_id);
    if let Err(e) = state
        .nc
        .publish(
            async_nats::subject::Subject::from(events),
            data.clone().into(),
        )
        .await
    {
        tracing::error!("NATS events publish failed: {}", e);
    }

    // Durable archive copy -- gated inside publish_with_dedup. msg-id
    // is monotonic per session, so a publisher retry of the same
    // logical event reuses it and JetStream's duplicate window
    // collapses it.
    let archive = archive_subject(&state.session_id);
    let msg_id = format!("archive.{}.{}", state.session_id, seq);
    if let Err(e) =
        publish_with_dedup(&state.nc, archive, data.into(), &msg_id).await
    {
        tracing::error!("NATS archive publish failed: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_message_with_all_fields() {
        let msg = build_message("s-abc", "agent.text", json!({ "text": "hi" }), 7);
        assert_eq!(msg.session_id, "s-abc");
        assert_eq!(msg.r#type, "agent.text");
        assert_eq!(msg.sequence, 7);
        assert_eq!(msg.payload["text"], "hi");
    }

    #[test]
    fn timestamp_is_rfc3339() {
        let msg = build_message("s", "t", json!({}), 0);
        assert!(msg.timestamp.contains('T'));
    }

    #[test]
    fn events_subject_format() {
        assert_eq!(events_subject("xyz"), "x1.session.xyz.events");
    }

    #[test]
    fn events_subject_preserves_uuid() {
        let id = "019d6a7a-b559-7650-bc7d-ac466c9a2dbb";
        assert_eq!(
            events_subject(id),
            "x1.session.019d6a7a-b559-7650-bc7d-ac466c9a2dbb.events"
        );
    }

    #[test]
    fn archive_subject_is_distinct_from_events() {
        let id = "019d6a7a-b559-7650-bc7d-ac466c9a2dbb";
        assert_eq!(
            archive_subject(id),
            "x1.session.019d6a7a-b559-7650-bc7d-ac466c9a2dbb.archive"
        );
        assert_ne!(archive_subject(id), events_subject(id));
    }

    #[test]
    fn message_serializes_with_expected_shape() {
        let msg = build_message("s1", "agent.text", json!({ "text": "hi" }), 4);
        let s = serde_json::to_string(&msg).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["session_id"], "s1");
        assert_eq!(parsed["type"], "agent.text");
        assert_eq!(parsed["sequence"], 4);
        assert_eq!(parsed["payload"]["text"], "hi");
        assert!(parsed["timestamp"].is_string());
    }

    #[test]
    fn sequence_is_monotonic() {
        let seq = std::sync::atomic::AtomicU64::new(0);
        let a = seq.fetch_add(1, Ordering::Relaxed);
        let b = seq.fetch_add(1, Ordering::Relaxed);
        assert_eq!(a, 0);
        assert_eq!(b, 1);
    }
}
