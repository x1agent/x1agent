//! Calendar bridge — `/calendar/*` HTTP routes → `x1.provider.calendar.*` NATS.

use axum::extract::State;
use axum::Json;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use crate::AppState;

const PROVIDER_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
pub struct ListEventsRequest {
    #[serde(default)]
    pub calendar_id: Option<String>,
    #[serde(default)]
    pub time_min: Option<String>,
    #[serde(default)]
    pub time_max: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub max_results: Option<u32>,
}

#[derive(Deserialize)]
pub struct CreateEventRequest {
    #[serde(default)]
    pub calendar_id: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub description: Option<String>,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub attendees: Option<Vec<String>>,
    #[serde(default)]
    pub location: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateEventRequest {
    #[serde(default)]
    pub calendar_id: Option<String>,
    pub event_id: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub attendees: Option<Vec<String>>,
    #[serde(default)]
    pub location: Option<String>,
}

#[derive(Deserialize)]
pub struct DeleteEventRequest {
    #[serde(default)]
    pub calendar_id: Option<String>,
    pub event_id: String,
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

pub async fn handle_list_events(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ListEventsRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "calendar_id": req.calendar_id,
        "time_min": req.time_min,
        "time_max": req.time_max,
        "q": req.q,
        "max_results": req.max_results,
    });
    nats_provider_request(&state, "x1.provider.calendar.list_events", body).await
}

pub async fn handle_create_event(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateEventRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "calendar_id": req.calendar_id,
        "summary": req.summary,
        "description": req.description,
        "start": req.start,
        "end": req.end,
        "attendees": req.attendees,
        "location": req.location,
    });
    nats_provider_request(&state, "x1.provider.calendar.create_event", body).await
}

pub async fn handle_update_event(
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateEventRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "calendar_id": req.calendar_id,
        "event_id": req.event_id,
        "summary": req.summary,
        "description": req.description,
        "start": req.start,
        "end": req.end,
        "attendees": req.attendees,
        "location": req.location,
    });
    nats_provider_request(&state, "x1.provider.calendar.update_event", body).await
}

pub async fn handle_delete_event(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DeleteEventRequest>,
) -> axum::response::Response {
    let user_id = match user_id_or_error() {
        Ok(u) => u,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "user_id": user_id,
        "calendar_id": req.calendar_id,
        "event_id": req.event_id,
    });
    nats_provider_request(&state, "x1.provider.calendar.delete_event", body).await
}
