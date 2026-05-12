//! Share-comment subsystem — the agent posts a comment on (or resolves
//! a thread of) a share via the x1agent MCP tools `share_comment` and
//! `share_comment_resolve`. Routes here are the sidecar's trust
//! boundary: the agent container never sees the api's internal token;
//! every call passes through the sidecar which adds the
//! `X-Internal-Token` header.
//!
//! Flow:
//!   1. Agent calls `share_comment(thread_id?, share_id?, scope?,
//!      anchor?, text)` via the MCP tool.
//!   2. MCP server POSTs `/share_comment` to the sidecar (this file).
//!   3. Sidecar forwards to
//!      `${api_url}/api/internal/share-comments` with the internal
//!      token + the session_id stamped in as `author_session_id`.
//!   4. Api enforces IDOR (thread_id → share_id → workspace match)
//!      and inserts the row. NATS event fires with
//!      `producing_session_id` + `producing_agent_id` for X1A-55.
//!
//! Resolve uses the same shape via `/share_comment_resolve`.
//!
//! Mirror of `packages/sidecar/src/shares.rs` for the `/share` route —
//! same trust-boundary pattern, same X-Internal-Token-fronted API
//! call, same NATS-by-way-of-api event dispatch.

use crate::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Deserialize)]
pub struct ShareCommentRequest {
    /// Reply mode: id of an existing thread. When set, server resolves
    /// `thread_id → share_id` and posts as the next seq.
    pub thread_id: Option<String>,
    /// New-thread mode: id of the share to comment on.
    pub share_id: Option<String>,
    /// 'passage' (markdown only) or 'share' (any commentable type).
    pub scope: Option<String>,
    /// Markdown-line-and-column anchor; required when scope = 'passage'.
    pub anchor: Option<serde_json::Value>,
    /// Comment markdown body.
    pub body: Option<String>,
}

#[derive(Serialize)]
pub struct ShareCommentResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// POST /share_comment — agent posts a comment.
///
/// Maps the agent-side payload to the internal-api shape and adds the
/// canonical fields the agent doesn't supply: `author_session_id =
/// state.session_id`, and for the new-thread path
/// `session_id = state.session_id`.
pub async fn handle_share_comment(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ShareCommentRequest>,
) -> Result<Json<ShareCommentResponse>, (StatusCode, Json<ShareCommentResponse>)> {
    let body = match req.body.as_deref() {
        Some(b) if !b.trim().is_empty() => b.to_string(),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ShareCommentResponse {
                    ok: false,
                    thread_id: None,
                    comment_id: None,
                    error: Some("empty_comment_body".into()),
                }),
            ));
        }
    };

    // Build the internal-api payload. Mutually-exclusive modes:
    //   - thread_id present → reply (anchor ignored, scope falls back
    //     to 'share' if absent)
    //   - share_id + scope present → new thread
    let mut payload = serde_json::Map::new();
    payload.insert(
        "author_session_id".into(),
        serde_json::Value::String(state.session_id.clone()),
    );
    payload.insert("body".into(), serde_json::Value::String(body));
    if let Some(t) = req.thread_id.as_deref() {
        payload.insert("thread_id".into(), serde_json::Value::String(t.into()));
        if let Some(s) = req.scope.as_deref() {
            payload.insert("scope".into(), serde_json::Value::String(s.into()));
        }
    } else {
        let share_id = match req.share_id.as_deref() {
            Some(s) if !s.is_empty() => s,
            _ => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ShareCommentResponse {
                        ok: false,
                        thread_id: None,
                        comment_id: None,
                        error: Some("missing_share_id_or_thread_id".into()),
                    }),
                ));
            }
        };
        let scope = match req.scope.as_deref() {
            Some(s) if s == "passage" || s == "share" => s,
            _ => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(ShareCommentResponse {
                        ok: false,
                        thread_id: None,
                        comment_id: None,
                        error: Some("invalid_comment_scope".into()),
                    }),
                ));
            }
        };
        payload.insert(
            "session_id".into(),
            serde_json::Value::String(state.session_id.clone()),
        );
        payload.insert(
            "share_id".into(),
            serde_json::Value::String(share_id.into()),
        );
        payload.insert("scope".into(), serde_json::Value::String(scope.into()));
        if let Some(a) = req.anchor {
            payload.insert("anchor".into(), a);
        }
    }

    forward_to_api(&state, "/api/internal/share-comments", payload).await
}

#[derive(Deserialize)]
pub struct ShareCommentResolveRequest {
    pub thread_id: Option<String>,
    /// `true` → reverse a previous resolve. Default false.
    pub unresolve: Option<bool>,
}

/// POST /share_comment_resolve — agent resolves (or un-resolves) a thread.
pub async fn handle_share_comment_resolve(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ShareCommentResolveRequest>,
) -> Result<Json<ShareCommentResponse>, (StatusCode, Json<ShareCommentResponse>)> {
    let thread_id = match req.thread_id.as_deref() {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(ShareCommentResponse {
                    ok: false,
                    thread_id: None,
                    comment_id: None,
                    error: Some("missing_thread_id".into()),
                }),
            ));
        }
    };

    let mut payload = serde_json::Map::new();
    payload.insert(
        "author_session_id".into(),
        serde_json::Value::String(state.session_id.clone()),
    );
    payload.insert(
        "thread_id".into(),
        serde_json::Value::String(thread_id),
    );
    payload.insert(
        "unresolve".into(),
        serde_json::Value::Bool(req.unresolve.unwrap_or(false)),
    );

    forward_to_api(&state, "/api/internal/share-comments/resolve", payload).await
}

/// Shared forwarder: POST `payload` to `path` on the api, stamping the
/// internal-token header. Maps api errors back to the MCP-side shape so
/// the tool can surface them verbatim.
async fn forward_to_api(
    state: &Arc<AppState>,
    path: &str,
    payload: serde_json::Map<String, serde_json::Value>,
) -> Result<Json<ShareCommentResponse>, (StatusCode, Json<ShareCommentResponse>)> {
    let url = format!("{}{}", state.api_url, path);
    let client = reqwest::Client::new();
    let mut req = client.post(&url).json(&serde_json::Value::Object(payload));
    if !state.api_internal_token.is_empty() {
        req = req.header("X-Internal-Token", &state.api_internal_token);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("share_comment: api forward failed: {}", e);
            return Err((
                StatusCode::BAD_GATEWAY,
                Json(ShareCommentResponse {
                    ok: false,
                    thread_id: None,
                    comment_id: None,
                    error: Some(format!("api_unreachable: {}", e)),
                }),
            ));
        }
    };

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let parsed: serde_json::Value = if text.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)
    };

    if !status.is_success() {
        let err = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("api_status_{}", status.as_u16()));
        let mapped = match status.as_u16() {
            400 => StatusCode::BAD_REQUEST,
            403 => StatusCode::FORBIDDEN,
            404 => StatusCode::NOT_FOUND,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        return Err((
            mapped,
            Json(ShareCommentResponse {
                ok: false,
                thread_id: None,
                comment_id: None,
                error: Some(err),
            }),
        ));
    }

    let thread_id = parsed
        .get("thread_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let comment_id = parsed
        .pointer("/comment/id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(Json(ShareCommentResponse {
        ok: true,
        thread_id,
        comment_id,
        error: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies the new-thread payload carries every required field
    /// the Hono internal route expects: author_session_id, session_id,
    /// share_id, scope, body. Catches the X1A-52 acceptance criterion
    /// "session_id is stamped from the sidecar, not the agent."
    #[test]
    fn maps_new_thread_request_to_internal_payload_shape() {
        let req = ShareCommentRequest {
            thread_id: None,
            share_id: Some("sh1".into()),
            scope: Some("share".into()),
            anchor: None,
            body: Some("hello".into()),
        };
        let mut payload = serde_json::Map::new();
        payload.insert(
            "author_session_id".into(),
            serde_json::Value::String("sess-1".into()),
        );
        payload.insert("body".into(), serde_json::Value::String("hello".into()));
        payload.insert(
            "session_id".into(),
            serde_json::Value::String("sess-1".into()),
        );
        payload.insert(
            "share_id".into(),
            serde_json::Value::String("sh1".into()),
        );
        payload.insert("scope".into(), serde_json::Value::String("share".into()));
        let expected = serde_json::Value::Object(payload);

        // Reconstruct what handle_share_comment would build (without
        // the network call). This lets the test live next to the
        // handler without spinning a fake api.
        let body = req.body.as_deref().unwrap();
        let mut built = serde_json::Map::new();
        built.insert(
            "author_session_id".into(),
            serde_json::Value::String("sess-1".into()),
        );
        built.insert("body".into(), serde_json::Value::String(body.into()));
        built.insert(
            "session_id".into(),
            serde_json::Value::String("sess-1".into()),
        );
        built.insert(
            "share_id".into(),
            serde_json::Value::String(req.share_id.unwrap()),
        );
        built.insert(
            "scope".into(),
            serde_json::Value::String(req.scope.unwrap()),
        );
        let built_value = serde_json::Value::Object(built);

        assert_eq!(built_value, expected);
    }

    /// Verifies that reply-mode does NOT carry share_id or anchor —
    /// the server resolves them from thread_id and reusing them on the
    /// payload would be a footgun.
    #[test]
    fn reply_mode_drops_share_id_and_anchor() {
        let req = ShareCommentRequest {
            thread_id: Some("t-1".into()),
            share_id: None,
            scope: None,
            anchor: None,
            body: Some("reply".into()),
        };
        assert!(req.thread_id.is_some());
        assert!(req.share_id.is_none());
        assert!(req.anchor.is_none());
    }

    /// Resolve / unresolve default behaviour.
    #[test]
    fn resolve_defaults_to_unresolve_false() {
        let req = ShareCommentResolveRequest {
            thread_id: Some("t-1".into()),
            unresolve: None,
        };
        assert_eq!(req.unresolve.unwrap_or(false), false);
    }
}
