//! Messaging provider bridge.
//!
//! The agent calls `POST /messaging/post_message` on the sidecar. The
//! sidecar does a NATS request on `x1.provider.messaging.post_message`
//! with a 5s timeout and relays the provider's reply verbatim. The
//! agent never speaks NATS directly and never holds messaging-provider
//! credentials.

use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use crate::AppState;

#[derive(Deserialize)]
pub struct PostMessageRequest {
    pub channel: String,
    pub text: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Serialize)]
pub struct ErrorBody {
    pub ok: bool,
    pub error: ErrorDetails,
}

#[derive(Serialize)]
pub struct ErrorDetails {
    pub code: String,
    pub message: String,
}

pub async fn handle_post_message(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PostMessageRequest>,
) -> axum::response::Response {
    let body = serde_json::json!({
        "channel": req.channel,
        "text": req.text,
        "thread_id": req.thread_id,
        "username": req.username,
    });
    let payload = match serde_json::to_vec(&body) {
        Ok(b) => b,
        Err(e) => return error_response(StatusCode::INTERNAL_SERVER_ERROR,
            "encode_failed", &e.to_string()),
    };

    let res = tokio::time::timeout(
        Duration::from_secs(5),
        state.nc.request("x1.provider.messaging.post_message", payload.into()),
    )
    .await;

    match res {
        Ok(Ok(msg)) => axum::http::Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(msg.payload))
            .unwrap_or_else(|_| {
                error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "response_build_failed",
                    "",
                )
            }),
        Ok(Err(e)) => error_response(
            StatusCode::BAD_GATEWAY,
            "nats_request_failed",
            &e.to_string(),
        ),
        Err(_) => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "provider_timeout",
            "messaging provider did not reply within 5s — is one subscribed?",
        ),
    }
}

fn error_response(
    status: StatusCode,
    code: &str,
    message: &str,
) -> axum::response::Response {
    (
        status,
        Json(ErrorBody {
            ok: false,
            error: ErrorDetails {
                code: code.into(),
                message: message.into(),
            },
        }),
    )
        .into_response()
}
