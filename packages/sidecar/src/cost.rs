//! Cost surfacing — proxy endpoints the agent's MCP tools forward to.
//!
//! Three GET routes, each pure pass-through to the api's internal
//! cost endpoints. The agent's session_id is known to the sidecar at
//! boot via env, so the agent never needs to name a session — its
//! `get_session_cost()` MCP tool always resolves to "my current
//! session" because the sidecar fills in the id here. Same idea for
//! `get_session_tree_cost()` and `get_agent_cost(window)`.
//!
//! Workspace scoping happens on the api side: it resolves
//! session_id → agent_id → workspace_id and feeds workspace_id into
//! the WHERE clauses, so a future bug in this proxy can't escape the
//! caller's tenant. See X1A-37.

use axum::extract::{Query, State};
use axum::response::IntoResponse;
use axum::Json;
use reqwest::StatusCode;
use serde::Deserialize;
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
pub struct AgentCostQuery {
    pub window: Option<String>,
}

pub async fn handle_session_cost(
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/internal/sessions/{}/cost",
        state.api_url.trim_end_matches('/'),
        state.session_id,
    );
    let res = client
        .get(&url)
        .header("x-internal-token", &state.api_internal_token)
        .send()
        .await;
    relay_json(res).await
}

pub async fn handle_session_tree_cost(
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/internal/sessions/{}/cost-tree",
        state.api_url.trim_end_matches('/'),
        state.session_id,
    );
    let res = client
        .get(&url)
        .header("x-internal-token", &state.api_internal_token)
        .send()
        .await;
    relay_json(res).await
}

pub async fn handle_agent_cost(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AgentCostQuery>,
) -> axum::response::Response {
    let window = q.window.as_deref().unwrap_or("7d");
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/internal/sessions/{}/agent-cost?window={}",
        state.api_url.trim_end_matches('/'),
        state.session_id,
        urlencoding::encode(window),
    );
    let res = client
        .get(&url)
        .header("x-internal-token", &state.api_internal_token)
        .send()
        .await;
    relay_json(res).await
}

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
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({
                                "error": "body_build_failed"
                            })),
                        )
                            .into_response()
                    }),
                Err(e) => (
                    StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({
                        "error": "upstream_body_failed",
                        "message": e.to_string(),
                    })),
                )
                    .into_response(),
            }
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "error": "upstream_failed",
                "message": e.to_string(),
            })),
        )
            .into_response(),
    }
}
