//! Orchestration endpoints exposed to the agent.
//!
//! These let an orchestrator agent ask its sidecar to spawn a child
//! session or enumerate the agents it's allowed to spawn. The sidecar
//! forwards each call to the api's `/api/internal/sessions/*` routes,
//! adding the API internal token — the agent container never sees the
//! token itself.

use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
pub struct SpawnRequest {
    pub child_agent_id: String,
}

#[derive(Serialize)]
pub struct ErrorBody {
    pub error: String,
    pub message: String,
}

pub async fn handle_spawn(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SpawnRequest>,
) -> axum::response::Response {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/internal/sessions/spawn",
        state.api_url.trim_end_matches('/')
    );
    let body = serde_json::json!({
        "parent_session_id": state.session_id,
        "child_agent_id": req.child_agent_id,
    });
    let res = client
        .post(&url)
        .header("x-internal-token", &state.api_internal_token)
        .json(&body)
        .send()
        .await;
    relay_json(res).await
}

pub async fn handle_spawnable(
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/internal/sessions/{}/spawnable",
        state.api_url.trim_end_matches('/'),
        state.session_id
    );
    let res = client
        .get(&url)
        .header("x-internal-token", &state.api_internal_token)
        .send()
        .await;
    relay_json(res).await
}

/// Forward the api's status + body verbatim to the caller. On transport
/// failure, return 502 bad_gateway with the error message.
async fn relay_json(
    res: Result<reqwest::Response, reqwest::Error>,
) -> axum::response::Response {
    match res {
        Ok(r) => {
            let status = r.status();
            match r.bytes().await {
                Ok(bytes) => axum::http::Response::builder()
                    .status(status)
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(bytes))
                    .unwrap_or_else(|_| {
                        (StatusCode::INTERNAL_SERVER_ERROR, "body build failed")
                            .into_response()
                    }),
                Err(e) => error_response(
                    StatusCode::BAD_GATEWAY,
                    "upstream_body_failed",
                    &e.to_string(),
                ),
            }
        }
        Err(e) => error_response(
            StatusCode::BAD_GATEWAY,
            "upstream_failed",
            &e.to_string(),
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
            error: code.into(),
            message: message.into(),
        }),
    )
        .into_response()
}
