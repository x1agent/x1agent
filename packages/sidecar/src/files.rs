//! `files` provider bridge.
//!
//! The agent POSTs to `/files/list`, `/files/get`, `/files/download`
//! on the sidecar. The sidecar attaches `user_id` (from
//! TRIGGERING_USER_ID env) and forwards the request to the
//! corresponding NATS subject:
//!
//!   POST /files/list      → x1.provider.files.list
//!   POST /files/get       → x1.provider.files.get
//!   POST /files/download  → x1.provider.files.download
//!
//! The reply from the subscribed provider (google-workspace,
//! microsoft-365, …) is relayed verbatim. The agent never speaks NATS
//! directly, never sees user OAuth tokens, and never knows which
//! provider is currently serving the `files` domain — that's the
//! whole point of the documented provider model.
//!
//! See docs/providers/overview.md for the broader pattern.

use axum::extract::State;
use axum::Json;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use crate::AppState;

const PROVIDER_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
pub struct ListFilesRequest {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub page_size: Option<u32>,
    #[serde(default)]
    pub fields: Option<String>,
}

#[derive(Deserialize)]
pub struct GetOrDownloadRequest {
    pub file_id: String,
}

#[derive(Serialize)]
struct ErrorBody {
    ok: bool,
    error: ErrorDetails,
}

#[derive(Serialize)]
struct ErrorDetails {
    code: String,
    message: String,
}

fn error_response(
    status: StatusCode,
    code: &str,
    message: &str,
) -> axum::response::Response {
    axum::response::IntoResponse::into_response((
        status,
        Json(ErrorBody {
            ok: false,
            error: ErrorDetails {
                code: code.to_string(),
                message: message.to_string(),
            },
        }),
    ))
}

fn user_id_or_error() -> Result<String, axum::response::Response> {
    let user_id = std::env::var("TRIGGERING_USER_ID").unwrap_or_default();
    if user_id.is_empty() {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "permission_required",
            "no TRIGGERING_USER_ID set on this session pod — provider calls require a user attribution",
        ));
    }
    Ok(user_id)
}

async fn nats_provider_request(
    state: &Arc<AppState>,
    subject: &'static str,
    body: serde_json::Value,
) -> axum::response::Response {
    let payload = match serde_json::to_vec(&body) {
        Ok(p) => p,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "encode_failed",
                &e.to_string(),
            )
        }
    };
    let res = tokio::time::timeout(
        PROVIDER_TIMEOUT,
        state.nc.request(subject, payload.into()),
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
            &format!(
                "no provider replied to {} within {}s — is the google-workspace provider deployed?",
                subject,
                PROVIDER_TIMEOUT.as_secs()
            ),
        ),
    }
}

pub async fn handle_list(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ListFilesRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "query": req.query,
        "page_size": req.page_size,
        "fields": req.fields,
    });
    nats_provider_request(&state, "x1.provider.files.list", body).await
}

pub async fn handle_get(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GetOrDownloadRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "file_id": req.file_id,
    });
    nats_provider_request(&state, "x1.provider.files.get", body).await
}

pub async fn handle_download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GetOrDownloadRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "file_id": req.file_id,
    });
    nats_provider_request(&state, "x1.provider.files.download", body).await
}
