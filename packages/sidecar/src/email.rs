//! Email (Gmail) bridge — `/email/*` HTTP routes → `x1.provider.email.*` NATS.

use axum::extract::State;
use axum::Json;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use crate::AppState;

const PROVIDER_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
pub struct ListThreadsRequest {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub max_results: Option<u32>,
    #[serde(default)]
    pub page_token: Option<String>,
}

#[derive(Deserialize)]
pub struct GetMessageRequest {
    pub message_id: String,
}

#[derive(Deserialize)]
pub struct SendEmailRequest {
    pub to: String,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub cc: Option<Vec<String>>,
    #[serde(default)]
    pub bcc: Option<Vec<String>>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub reply_to_thread_id: Option<String>,
}

#[derive(Deserialize)]
pub struct TrashEmailRequest {
    pub message_id: String,
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

pub async fn handle_list_threads(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ListThreadsRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "q": req.q,
        "max_results": req.max_results,
        "page_token": req.page_token,
    });
    nats_provider_request(&state, "x1.provider.email.list_threads", body).await
}

pub async fn handle_get_message(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GetMessageRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "message_id": req.message_id,
    });
    nats_provider_request(&state, "x1.provider.email.get_message", body).await
}

pub async fn handle_send(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SendEmailRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "to": req.to,
        "subject": req.subject,
        "body": req.body,
        "cc": req.cc,
        "bcc": req.bcc,
        "content_type": req.content_type,
        "reply_to_thread_id": req.reply_to_thread_id,
    });
    nats_provider_request(&state, "x1.provider.email.send", body).await
}

pub async fn handle_trash(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TrashEmailRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "message_id": req.message_id,
    });
    nats_provider_request(&state, "x1.provider.email.trash", body).await
}
