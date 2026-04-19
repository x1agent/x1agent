use crate::AppState;
use futures_util::StreamExt;
use serde::Serialize;
use std::sync::Arc;

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

/// `x1.session.{id}.input` → POST to the agent's /inject endpoint.
pub async fn input_subscriber(state: Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    let subject = format!("x1.session.{}.input", state.session_id);
    let mut sub = state
        .nc
        .subscribe(async_nats::subject::Subject::from(subject))
        .await?;
    let client = reqwest::Client::new();

    // Wait for the agent's HTTP server to come up.
    let health_url = format!("{}/health", state.channel_url);
    for attempt in 1..=60_u32 {
        match client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => break,
            _ => {
                if attempt == 60 {
                    tracing::error!("Agent inject endpoint never became ready");
                    return Ok(());
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
    tracing::info!("Subscribed to input for session {}", state.session_id);

    let inject_url = format!("{}/inject", state.channel_url);

    while let Some(msg) = sub.next().await {
        let parsed = match parse_input_message(&msg.payload) {
            Some(p) => p,
            None => {
                tracing::warn!("input_subscriber: dropping malformed message");
                continue;
            }
        };

        let body = InjectPayload {
            text: parsed.text,
            sender_id: parsed.sender_id,
            request_id: parsed.request_id,
        };
        match client.post(&inject_url).json(&body).send().await {
            Ok(_) => tracing::info!("Injected message into agent"),
            Err(e) => tracing::error!("Agent inject failed: {}", e),
        }
    }
    Ok(())
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
