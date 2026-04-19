use crate::{AppState, SessionMessage};
use async_nats::Client as NatsClient;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// Connect to NATS with retries. Sidecar starts before NATS may be
/// ready in the same pod/cluster; a small retry loop hides that race.
pub async fn connect_with_retry(url: &str, max_retries: u32) -> NatsClient {
    for attempt in 1..=max_retries {
        match async_nats::connect(url).await {
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

pub async fn publish_event(
    state: &Arc<AppState>,
    event_type: &str,
    payload: serde_json::Value,
) {
    let seq = state.sequence.fetch_add(1, Ordering::Relaxed);
    let message = build_message(&state.session_id, event_type, payload, seq);
    let subject = events_subject(&state.session_id);
    let data = serde_json::to_vec(&message).unwrap_or_default();
    if let Err(e) = state
        .nc
        .publish(async_nats::subject::Subject::from(subject), data.into())
        .await
    {
        tracing::error!("NATS publish failed: {}", e);
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
