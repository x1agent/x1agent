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
    /// Optional per-spawn Claude model override (X1A-40). The agent
    /// passes a short name ("sonnet" / "opus" / "haiku") or a full
    /// model id; the api resolves and re-checks against the admin-
    /// curated enabled-models allowlist. We forward verbatim — the
    /// sidecar is not the policy authority.
    #[serde(default)]
    pub model: Option<String>,
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
pub struct CancelSessionRequest {
    pub child_session_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Deserialize)]
pub struct ShareToChildRequest {
    pub child_session_id: String,
    pub source_path: String,
    #[serde(default)]
    pub dest_path: Option<String>,
}

#[derive(Deserialize)]
pub struct PullFromChildRequest {
    pub child_session_id: String,
    #[serde(default)]
    pub paths: Option<Vec<String>>,
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
        "model": req.model,
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

/// Orchestrator → child cancel (X1A-118). The orchestrator's
/// `cancel_session` MCP tool POSTs here with the target child
/// session id. The sidecar forwards to the api with the orchestrator's
/// own session id stamped as `parent_session_id`. Authorization is
/// the parent → child relationship on the api side — the agent
/// container never has the internal token.
///
/// Idempotent: a cancel call on an already-terminal child returns
/// `cancelled: false` rather than an error, so racing wakes don't
/// trip the orchestrator.
pub async fn handle_cancel_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CancelSessionRequest>,
) -> axum::response::Response {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/internal/sessions/{}/cancel-by-parent",
        state.api_url.trim_end_matches('/'),
        urlencoding::encode(&req.child_session_id),
    );
    let body = serde_json::json!({
        "parent_session_id": state.session_id,
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

/// Orchestrator → child WORKSPACE pull. Inverse of share_to_child:
/// the orchestrator names a child it spawned and the api snapshots
/// that child's /workspace into the orchestrator's own
/// /workspace/workers/<child_id>/. Used to surface a worker's
/// generated outputs (reports, datasets, files) so the orchestrator
/// can read them with normal tools (Read, Bash, Grep) — sidesteps
/// the brittle "worker calls share" path that small models routinely
/// skip.
///
/// Snapshot semantics. A second call overwrites the same
/// /workspace/workers/<child_id>/ directory. Authorization is the
/// parent → child relationship on the api side.
pub async fn handle_pull_from_child(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PullFromChildRequest>,
) -> axum::response::Response {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/internal/sessions/{}/pull-for-parent",
        state.api_url.trim_end_matches('/'),
        urlencoding::encode(&req.child_session_id),
    );
    let body = serde_json::json!({
        "parent_session_id": state.session_id,
        "paths": req.paths,
    });
    let res = client
        .post(&url)
        .header("x-internal-token", &state.api_internal_token)
        .json(&body)
        .send()
        .await;
    relay_json(res).await
}

/// Orchestrator → child snapshot copy (X1A-63). The orchestrator names
/// a file or folder under its own `/workspace` plus a child session
/// id; the api confirms the child belongs to this orchestrator,
/// resolves the child's workspace volume, and stages a snapshot copy
/// into `/workspace/{dest_path}` on the child pod.
///
/// Snapshot semantics ONLY — explicitly not a live-link / subscription.
/// A second call with the same source_path re-stages a fresh snapshot;
/// the child sees the new bytes the next time it opens the file.
pub async fn handle_share_to_child(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ShareToChildRequest>,
) -> axum::response::Response {
    use axum::response::IntoResponse;

    // Validate source path against the workspace root. Reuses the
    // share-route's normalization so traversal and absolute-outside
    // paths fail the same way (`..` is rejected; absolute paths must
    // start with /workspace).
    let rel_source = match crate::shares::normalize_request_path(&req.source_path) {
        Ok(r) => r,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_source_path",
                &e,
            );
        }
    };
    let abs_source = std::path::PathBuf::from("/workspace").join(&rel_source);
    let canonical = match abs_source.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "source_not_accessible",
                &e.to_string(),
            )
        }
    };
    if !canonical.starts_with("/workspace") {
        return error_response(
            StatusCode::BAD_REQUEST,
            "source_outside_workspace",
            "",
        );
    }

    // Read the file(s) and base64-encode for the API forward — same
    // wire shape as upload_to_api in shares.rs, just routed to the
    // child-staging endpoint instead of the share-write one.
    let collected = match crate::shares::collect_files_for_transfer(&canonical) {
        Ok(c) => c,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "collect_failed",
                &e,
            );
        }
    };
    if collected.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "no_files",
            "source path is empty",
        );
    }

    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/internal/sessions/{}/share-to-child",
        state.api_url.trim_end_matches('/'),
        urlencoding::encode(&req.child_session_id),
    );
    let body = serde_json::json!({
        "parent_session_id": state.session_id,
        "dest_path": req.dest_path,
        "files": collected
            .iter()
            .map(|(path, content)| serde_json::json!({
                "path": path,
                "content": crate::shares::base64_encode_public(content),
            }))
            .collect::<Vec<_>>(),
    });
    let res = client
        .post(&url)
        .header("x-internal-token", &state.api_internal_token)
        .json(&body)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await;
    relay_json(res).await.into_response()
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
