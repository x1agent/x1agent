//! Sheets bridge — `/sheets/*` HTTP routes published as
//! `x1.provider.sheets.*` NATS requests. Same shape as files.rs.

use axum::extract::State;
use axum::Json;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use crate::AppState;

const PROVIDER_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
pub struct ReadRangeRequest {
    pub spreadsheet_id: String,
    pub range: String,
}

#[derive(Deserialize)]
pub struct UpdateRangeRequest {
    pub spreadsheet_id: String,
    pub range: String,
    pub values: Vec<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
pub struct AppendRowRequest {
    pub spreadsheet_id: String,
    pub sheet_name: String,
    pub values: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct CreateSpreadsheetRequest {
    pub title: String,
    #[serde(default)]
    pub sheet_titles: Option<Vec<String>>,
    #[serde(default)]
    pub parent_folder_id: Option<String>,
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
        Err(_) => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "provider_timeout",
            &format!("no provider replied to {} within {}s", subject, PROVIDER_TIMEOUT.as_secs()),
        ),
    }
}

pub async fn handle_read_range(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ReadRangeRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "spreadsheet_id": req.spreadsheet_id,
        "range": req.range,
    });
    nats_provider_request(&state, "x1.provider.sheets.read_range", body).await
}

pub async fn handle_update_range(
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateRangeRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "spreadsheet_id": req.spreadsheet_id,
        "range": req.range,
        "values": req.values,
    });
    nats_provider_request(&state, "x1.provider.sheets.update_range", body).await
}

pub async fn handle_append_row(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AppendRowRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "spreadsheet_id": req.spreadsheet_id,
        "sheet_name": req.sheet_name,
        "values": req.values,
    });
    nats_provider_request(&state, "x1.provider.sheets.append_row", body).await
}

pub async fn handle_create(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateSpreadsheetRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "title": req.title,
        "sheet_titles": req.sheet_titles,
        "parent_folder_id": req.parent_folder_id,
    });
    nats_provider_request(&state, "x1.provider.sheets.create", body).await
}
