//! Orchestration endpoints exposed to the agent.
//!
//! These let an orchestrator agent ask its sidecar to spawn a child
//! session or enumerate the agents it's allowed to spawn. The sidecar
//! forwards each call to the api's `/api/internal/sessions/*` routes,
//! adding the API internal token — the agent container never sees the
//! token itself.

use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::{AppState, SessionMessage};

#[derive(Deserialize)]
pub struct SpawnRequest {
    pub child_agent_id: String,
}

#[derive(Deserialize)]
pub struct InjectRequest {
    pub text: String,
}

#[derive(Deserialize)]
pub struct MessageCallerRequest {
    pub summary: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub needs_response: Option<bool>,
}

#[derive(Deserialize)]
pub struct QuietHintRequest {
    pub seconds: i64,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Deserialize)]
pub struct PreviewDeployRequest {
    pub repo_full_name: String,
    pub branch: String,
    pub commit_sha: String,
}

#[derive(Deserialize)]
pub struct ReadChildQuery {
    pub after_seq: Option<i64>,
    pub limit: Option<u32>,
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

pub async fn handle_read_child(
    State(state): State<Arc<AppState>>,
    Path(child_id): Path<String>,
    Query(q): Query<ReadChildQuery>,
) -> axum::response::Response {
    let client = reqwest::Client::new();
    let mut url = format!(
        "{}/api/internal/sessions/{}/child-events?parent_session_id={}",
        state.api_url.trim_end_matches('/'),
        child_id,
        state.session_id
    );
    if let Some(s) = q.after_seq {
        url.push_str(&format!("&after_seq={}", s));
    }
    if let Some(l) = q.limit {
        url.push_str(&format!("&limit={}", l));
    }
    let res = client
        .get(&url)
        .header("x-internal-token", &state.api_internal_token)
        .send()
        .await;
    relay_json(res).await
}

pub async fn handle_inject_child(
    State(state): State<Arc<AppState>>,
    Path(child_id): Path<String>,
    Json(req): Json<InjectRequest>,
) -> axum::response::Response {
    // Authorization: verify the child's parent_session_id equals our
    // session_id before we publish anything. The api has the truth;
    // we ask it to confirm by calling the same child-events endpoint
    // (it returns 403 not_your_child when the link is wrong).
    let client = reqwest::Client::new();
    let check_url = format!(
        "{}/api/internal/sessions/{}/child-events?parent_session_id={}&limit=1",
        state.api_url.trim_end_matches('/'),
        child_id,
        state.session_id
    );
    match client
        .get(&check_url)
        .header("x-internal-token", &state.api_internal_token)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => {
            let status = r.status();
            let body = r.bytes().await.unwrap_or_default();
            return axum::http::Response::builder()
                .status(status)
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap_or_else(|_| {
                    error_response(
                        StatusCode::BAD_GATEWAY,
                        "upstream_build_failed",
                        "",
                    )
                });
        }
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "upstream_failed",
                &e.to_string(),
            )
        }
    }

    // Publish a user.message envelope to the child's input subject.
    // Routes through channel::publish_input_envelope so the same
    // JetStream / NATS-core branch the api uses for wake publishes
    // applies here too. (parent_session_id, child_id, sequence) is
    // the dedup key -- monotonic per parent, so a publisher retry of
    // an inject reuses the same id and JetStream collapses it within
    // the duplicate window.
    let seq = state.sequence.fetch_add(1, Ordering::SeqCst);
    let msg = SessionMessage {
        session_id: child_id.clone(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        sequence: seq,
        r#type: "user.message".into(),
        payload: serde_json::json!({
            "text": req.text,
            "from_session_id": state.session_id,
        }),
    };
    let payload = match serde_json::to_vec(&msg) {
        Ok(b) => bytes::Bytes::from(b),
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "encode_failed",
                &e.to_string(),
            )
        }
    };
    let msg_id = format!(
        "wake.inject.{}.{}.{}",
        state.session_id, child_id, seq
    );
    match crate::channel::publish_input_envelope(&state.nc, &child_id, payload, &msg_id).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "sequence": seq })),
        )
            .into_response(),
        Err(e) => error_response(
            StatusCode::BAD_GATEWAY,
            "publish_failed",
            &e.to_string(),
        ),
    }
}

/// Child → parent explicit signal. The child agent calls the
/// `message_caller` MCP tool; its sidecar forwards to the api
/// internal route which validates + publishes the wake into the
/// parent orchestrator's input subject. The sidecar itself doesn't
/// touch NATS directly here — the api holds the parent-lookup logic.
pub async fn handle_message_caller(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MessageCallerRequest>,
) -> axum::response::Response {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/internal/sessions/{}/message-caller",
        state.api_url.trim_end_matches('/'),
        state.session_id,
    );
    let body = serde_json::json!({
        "summary": req.summary,
        "body": req.body,
        "needs_response": req.needs_response.unwrap_or(false),
    });
    let res = client
        .post(&url)
        .header("x-internal-token", &state.api_internal_token)
        .json(&body)
        .send()
        .await;
    relay_json(res).await
}

/// Child → watchdog "expect quiet for N seconds" hint. The child
/// agent calls the `expect_quiet_for` MCP tool; its sidecar forwards
/// to the api's internal route which records the hint in an
/// in-process store the watchdog consults before firing.
pub async fn handle_quiet_hint(
    State(state): State<Arc<AppState>>,
    Json(req): Json<QuietHintRequest>,
) -> axum::response::Response {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/internal/sessions/{}/quiet-hint",
        state.api_url.trim_end_matches('/'),
        state.session_id,
    );
    let body = serde_json::json!({
        "seconds": req.seconds,
        "reason": req.reason,
    });
    let res = client
        .post(&url)
        .header("x-internal-token", &state.api_internal_token)
        .json(&body)
        .send()
        .await;
    relay_json(res).await
}

/// Agent → api → preview-provider → agent. The agent invokes
/// preview_deploy; the sidecar forwards to the api's internal route,
/// which makes a NATS request to the preview provider and relays the
/// reply back. The api handles installation-id lookup + preview.yaml
/// fetch so the agent doesn't need the token or the git operation.
pub async fn handle_preview_deploy(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreviewDeployRequest>,
) -> axum::response::Response {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/internal/sessions/{}/preview-deploy",
        state.api_url.trim_end_matches('/'),
        state.session_id,
    );
    let body = serde_json::json!({
        "repo_full_name": req.repo_full_name,
        "branch": req.branch,
        "commit_sha": req.commit_sha,
    });
    let res = client
        .post(&url)
        .header("x-internal-token", &state.api_internal_token)
        .json(&body)
        // Preview builds (Kaniko + deploy + health wait) legitimately
        // take minutes. Don't timeout on the happy path.
        .timeout(std::time::Duration::from_secs(30 * 60))
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
