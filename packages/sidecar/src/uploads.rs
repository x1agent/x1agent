//! Upload-bytes credential proxy (X1A-96, t02/t05 P0 fix).
//!
//! Background:
//!   The agent container used to hold `API_INTERNAL_TOKEN` directly so
//!   it could `curl` `/api/internal/uploads/:id/raw` whenever it
//!   encountered an `[image: <uuid>]` token in a user message. That
//!   token is the single global master credential for every
//!   `/api/internal/*` route — `git-credential`, `user-oauth-token`,
//!   `spawn`, `inject`. Putting it in the documented-untrusted agent
//!   container collapsed the trust boundary the rest of the
//!   architecture rests on.
//!
//!   This module follows the established credential-proxy pattern
//!   (see `git.rs`, `user_tokens.rs`, `files.rs`): the agent POSTs to
//!   this sidecar route with just `{ upload_id }`; the sidecar reads
//!   its own `API_INTERNAL_TOKEN`, `TRIGGERING_USER_ID`, and
//!   `SESSION_ID` from env, calls the api on the agent's behalf, and
//!   relays the bytes back. The agent never sees the master token.
//!
//! Authorization layers:
//!   1. The api's `/uploads/:id/raw` already enforces upload.userId
//!      matches the caller's user_id and (when set) upload.sessionId
//!      matches the caller's session_id. We forward our pod-env
//!      `TRIGGERING_USER_ID` + `SESSION_ID` so those checks fire on
//!      every call.
//!   2. The api additionally returns the upload's owning workspace
//!      slug via the `X-Upload-Workspace-Slug` response header (when
//!      the upload is bound to a session). The sidecar verifies it
//!      matches its own `SESSION_WORKSPACE_SLUG` env — defense in
//!      depth in case the api-side session/user check is ever
//!      relaxed.
//!
//! Response shape (success):
//!   { ok: true, content_b64, mime, size, filename? }
//! Response shape (error):
//!   { ok: false, error: { code, message } }
//!
//! The shared `resolveImageTokens` in `packages/agent-runtime/src/image-tokens.ts`
//! decodes `content_b64` and writes the bytes to
//! `/workspace/.x1/uploads/<id>.<ext>` so the LLM's `Read` tool can
//! see them as image content blocks.

use axum::extract::State;
use axum::Json;
use base64::Engine;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use crate::AppState;

const UPLOAD_FETCH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
pub struct ReadUploadRequest {
    pub upload_id: String,
}

#[derive(Serialize)]
struct ReadUploadResponse {
    ok: bool,
    content_b64: String,
    mime: String,
    size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    filename: Option<String>,
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

/// Bare-uuid validation. Matches the api's UploadId guard and stops
/// path-traversal payloads from being smuggled into the upstream URL.
fn is_valid_upload_id(s: &str) -> bool {
    // 8-4-4-4-12 lowercase-or-uppercase hex
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *b != b'-' {
                    return false;
                }
            }
            _ => {
                let is_hex = b.is_ascii_hexdigit();
                if !is_hex {
                    return false;
                }
            }
        }
    }
    true
}

pub async fn handle_read_upload(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ReadUploadRequest>,
) -> axum::response::Response {
    if !is_valid_upload_id(&req.upload_id) {
        return error_response(StatusCode::BAD_REQUEST, "invalid_id", "upload_id must be a UUID");
    }

    let user_id = std::env::var("TRIGGERING_USER_ID").unwrap_or_default();
    if user_id.is_empty() {
        return error_response(
            StatusCode::FORBIDDEN,
            "permission_required",
            "no TRIGGERING_USER_ID set on this session pod — uploads require user attribution",
        );
    }

    if state.api_internal_token.is_empty() {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "no_internal_token",
            "sidecar has no API_INTERNAL_TOKEN — install is misconfigured",
        );
    }

    let url = format!(
        "{}/api/internal/uploads/{}/raw?user_id={}&session_id={}",
        state.api_url.trim_end_matches('/'),
        req.upload_id,
        urlencoding::encode(&user_id),
        urlencoding::encode(&state.session_id),
    );

    let client = match reqwest::Client::builder().timeout(UPLOAD_FETCH_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "client_build_failed",
                &e.to_string(),
            )
        }
    };

    let resp = match client
        .get(&url)
        .header("X-Internal-Token", &state.api_internal_token)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "api_fetch_failed",
                &e.to_string(),
            )
        }
    };

    let status = resp.status();
    if !status.is_success() {
        // Map common api error codes back to the caller. 404 stays
        // 404 (the upload isn't visible to this user/session).
        let code = match status.as_u16() {
            404 => "not_found",
            409 => "upload_not_ready",
            503 => "uploads_disabled",
            400 => "bad_request",
            _ => "upload_fetch_failed",
        };
        return error_response(
            // Forward 404/409/4xx as-is; collapse 5xx down to 502 so
            // upstream blame is clear without leaking api internals.
            if status.is_client_error() {
                status
            } else {
                StatusCode::BAD_GATEWAY
            },
            code,
            &format!("api returned {}", status),
        );
    }

    let mime = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let upload_ws_slug = resp
        .headers()
        .get("x-upload-workspace-slug")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_default();

    // Defense in depth: when the api surfaces the upload's owning
    // workspace, double-check it against this sidecar's session
    // workspace. The api's user_id+session_id check would already
    // refuse a cross-workspace fetch in normal operation — this
    // catches the case where the upload row is bound to a session in
    // a different workspace under the same user, which the strict
    // api check also handles but which we want to fail closed on
    // even if that branch ever changes.
    if !upload_ws_slug.is_empty()
        && !state.workspace_slug.is_empty()
        && upload_ws_slug != state.workspace_slug
    {
        return error_response(
            StatusCode::FORBIDDEN,
            "cross_workspace",
            "upload belongs to a different workspace",
        );
    }

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "api_body_read_failed",
                &e.to_string(),
            )
        }
    };
    let size = bytes.len();
    let content_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    axum::response::IntoResponse::into_response((
        StatusCode::OK,
        Json(ReadUploadResponse {
            ok: true,
            content_b64,
            mime,
            size,
            filename: None,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_validator_accepts_canonical() {
        assert!(is_valid_upload_id("7f3c4b58-91da-4f87-9a31-1f0b9e2d2c11"));
    }

    #[test]
    fn uuid_validator_accepts_uppercase() {
        assert!(is_valid_upload_id("7F3C4B58-91DA-4F87-9A31-1F0B9E2D2C11"));
    }

    #[test]
    fn uuid_validator_rejects_path_traversal() {
        assert!(!is_valid_upload_id("../etc/passwd"));
        assert!(!is_valid_upload_id("7f3c4b58-91da-4f87-9a31-1f0b9e2d2c11/raw"));
        assert!(!is_valid_upload_id("7f3c4b58-91da-4f87-9a31-1f0b9e2d2c11?x=1"));
    }

    #[test]
    fn uuid_validator_rejects_short() {
        assert!(!is_valid_upload_id(""));
        assert!(!is_valid_upload_id("not-a-uuid"));
        assert!(!is_valid_upload_id("7f3c4b58-91da-4f87-9a31-1f0b9e2d2c1")); // 35 chars
    }
}
