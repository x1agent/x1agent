//! Docs bridge — `/docs/*` HTTP routes → `x1.provider.docs.*` NATS.

use axum::extract::State;
use axum::Json;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use crate::AppState;

const PROVIDER_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
pub struct ReadDocRequest {
    pub document_id: String,
}

#[derive(Deserialize)]
pub struct CreateDocRequest {
    pub title: String,
    #[serde(default)]
    pub parent_folder_id: Option<String>,
}

#[derive(Deserialize)]
pub struct ReplaceTextRequest {
    pub document_id: String,
    pub find: String,
    pub replace: String,
    #[serde(default)]
    pub match_case: Option<bool>,
}

#[derive(Deserialize)]
pub struct AppendParagraphRequest {
    pub document_id: String,
    pub text: String,
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

fn error_response(status: StatusCode, code: &str, message: &str) -> axum::response::Response {
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
            "no TRIGGERING_USER_ID set",
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
        Err(e) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "encode_failed", &e.to_string()),
    };
    let res = tokio::time::timeout(PROVIDER_TIMEOUT, state.nc.request(subject, payload.into())).await;
    match res {
        Ok(Ok(msg)) => axum::http::Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(msg.payload))
            .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "response_build_failed", "")),
        Ok(Err(e)) => error_response(StatusCode::BAD_GATEWAY, "nats_request_failed", &e.to_string()),
        Err(_) => error_response(StatusCode::GATEWAY_TIMEOUT, "provider_timeout",
            &format!("no provider replied to {} within {}s", subject, PROVIDER_TIMEOUT.as_secs())),
    }
}

pub async fn handle_read(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ReadDocRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "document_id": req.document_id,
    });
    nats_provider_request(&state, "x1.provider.docs.read", body).await
}

pub async fn handle_create(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateDocRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "title": req.title,
        "parent_folder_id": req.parent_folder_id,
    });
    nats_provider_request(&state, "x1.provider.docs.create", body).await
}

pub async fn handle_replace_text(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ReplaceTextRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "document_id": req.document_id,
        "find": req.find,
        "replace": req.replace,
        "match_case": req.match_case,
    });
    nats_provider_request(&state, "x1.provider.docs.replace_text", body).await
}

pub async fn handle_append_paragraph(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AppendParagraphRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "document_id": req.document_id,
        "text": req.text,
    });
    nats_provider_request(&state, "x1.provider.docs.append_paragraph", body).await
}
