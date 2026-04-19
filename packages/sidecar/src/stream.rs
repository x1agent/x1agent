use crate::{nats_bridge, AppState};
use futures_util::StreamExt;
use std::sync::Arc;

/// Read the agent's SSE stream at :3100/stream; parse `data:` lines as
/// events and republish each to NATS.
pub async fn agent_stream_consumer(
    state: Arc<AppState>,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let health_url = format!("{}/health", state.agent_stream_url);
    let stream_url = format!("{}/stream", state.agent_stream_url);

    for attempt in 1..=60_u32 {
        match client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => break,
            _ => {
                if attempt == 60 {
                    tracing::error!("Agent stream never became ready");
                    return Ok(());
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }
    tracing::info!("Agent stream connected at {}", stream_url);

    let response = client.get(&stream_url).send().await?;
    let mut byte_stream = response.bytes_stream();
    let mut buffer = String::new();

    loop {
        match byte_stream.next().await {
            Some(Ok(bytes)) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(newline) = buffer.find('\n') {
                    let line = buffer[..newline].to_string();
                    buffer = buffer[newline + 1..].to_string();
                    if let Some(data) = line.strip_prefix("data: ") {
                        let data = data.trim();
                        if data.is_empty() || data == r#"{"type":"heartbeat"}"# {
                            continue;
                        }
                        let Ok(event) = serde_json::from_str::<serde_json::Value>(data) else {
                            continue;
                        };
                        let events: Vec<&serde_json::Value> = if event.is_array() {
                            event.as_array().unwrap().iter().collect()
                        } else {
                            vec![&event]
                        };
                        for e in events {
                            if let Some(t) = e["type"].as_str() {
                                let payload = e
                                    .get("payload")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                tracing::debug!("SSE → NATS: {}", t);
                                nats_bridge::publish_event(&state, t, payload).await;
                            }
                        }
                    }
                }
            }
            Some(Err(e)) => {
                tracing::warn!("SSE read error (agent may have exited): {}", e);
                break;
            }
            None => {
                tracing::info!("Agent SSE stream ended cleanly");
                break;
            }
        }
    }

    // The agent container has exited (cleanly or via error). There's no
    // more work for the sidecar — pending NATS publishes have a short
    // moment to flush, then we exit so the Job can transition to
    // Succeeded. Without this, the sidecar runs until the pod hits
    // activeDeadlineSeconds.
    tracing::info!("Agent stream closed — sidecar winding down");
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let _ = state.nc.drain().await;
    std::process::exit(0);
}
