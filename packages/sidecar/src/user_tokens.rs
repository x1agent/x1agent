//! User-OAuth credential helper.
//!
//! When a provider (Google Workspace, Microsoft 365, …) needs to call
//! an external API on behalf of the active user, it asks the sidecar
//! for an access token. The sidecar fetches it from the api's internal
//! `/api/internal/user-oauth-token` endpoint, which:
//!
//!   1. Looks up the user's encrypted token row for the (user, provider).
//!   2. Refreshes the access token if it's at-or-near expiry.
//!   3. Returns plaintext { access_token, expires_at }.
//!
//! Tokens never live in the agent container's env or filesystem. They
//! cross from api → sidecar over the cluster-internal HTTP path,
//! attached to a single outbound provider call, and never persisted
//! pod-side.
//!
//! See `docs/security/credential-proxy.md` and
//! `docs/providers/overview.md`.

use axum::extract::{Query, State};
use axum::Json;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

#[derive(Deserialize)]
pub struct UserTokenQuery {
    pub user_id: String,
    pub provider: String,
    /// Optional. When present, the api enforces that the user actually
    /// granted this scope on their last consent. Returns 403
    /// permission_required when the scope is missing.
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct UserTokenResponse {
    pub access_token: String,
    /// ISO-8601 timestamp or null when the provider didn't supply expiry.
    pub expires_at: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct UserTokenError {
    pub error: String,
    pub message: Option<String>,
}

/// HTTP handler. Other modules in this crate call `mint_user_token`
/// directly when they need a token for an outbound provider call —
/// this route exists so sibling provider deployments can ask for one
/// over a stable contract too (future, when providers run as
/// out-of-pod NATS subscribers AND need to bypass NATS for direct
/// HTTP-style auth flows).
pub async fn handle_user_token(
    State(state): State<Arc<AppState>>,
    Query(params): Query<UserTokenQuery>,
) -> axum::response::Response {
    match mint_user_token(
        &state.api_url,
        &state.api_internal_token,
        &params.user_id,
        &params.provider,
        params.scope.as_deref(),
    )
    .await
    {
        Ok(token) => axum::response::IntoResponse::into_response((
            StatusCode::OK,
            Json(token),
        )),
        Err(err) => err.into_http(),
    }
}

/// Programmatic entry — the rest of the sidecar (drive.rs, gmail.rs,
/// future provider modules) calls this directly. Returns a fresh
/// access token plus its expiry, OR a structured error caller maps to
/// the right wire shape.
pub async fn mint_user_token(
    api_url: &str,
    api_internal_token: &str,
    user_id: &str,
    provider: &str,
    scope: Option<&str>,
) -> Result<UserTokenResponse, UserTokenFetchError> {
    let mut url = format!(
        "{}/api/internal/user-oauth-token?user_id={}&provider={}",
        api_url.trim_end_matches('/'),
        urlencoding::encode(user_id),
        urlencoding::encode(provider),
    );
    if let Some(s) = scope {
        url.push_str(&format!("&scope={}", urlencoding::encode(s)));
    }

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("X-Internal-Token", api_internal_token)
        .send()
        .await
        .map_err(|e| UserTokenFetchError::Transport(e.to_string()))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if status.is_success() {
        return serde_json::from_str::<UserTokenResponse>(&body)
            .map_err(|e| UserTokenFetchError::Parse(e.to_string()));
    }

    // 403 with `permission_required` is the load-bearing case — the
    // user hasn't granted the requested scope, or the refresh token
    // is gone. Caller should surface this to the agent so it can
    // emit a request_grant to the operator.
    let parsed: Option<UserTokenError> = serde_json::from_str(&body).ok();
    let (code, msg) = match parsed {
        Some(e) => (
            e.error,
            e.message.unwrap_or_else(|| body.clone()),
        ),
        None => ("unknown".to_string(), body.clone()),
    };

    Err(match (status.as_u16(), code.as_str()) {
        (403, "permission_required") => {
            UserTokenFetchError::PermissionRequired(msg)
        }
        (503, _) => UserTokenFetchError::Disabled(msg),
        (s, _) => UserTokenFetchError::ApiError(s, msg),
    })
}

#[derive(Debug)]
pub enum UserTokenFetchError {
    /// 403 permission_required from the api. User has not granted the
    /// scope or the refresh token is missing/revoked.
    PermissionRequired(String),
    /// 503 — substrate not configured (no userOAuthTokens wired in
    /// composition). Should never happen in a properly configured
    /// install but surfaces cleanly when a provider is enabled before
    /// Phase 0 has shipped.
    Disabled(String),
    /// Other non-2xx response from the api.
    ApiError(u16, String),
    /// Network / transport failure (no http response received).
    Transport(String),
    /// Successful response but body wasn't the expected shape.
    Parse(String),
}

impl UserTokenFetchError {
    pub fn into_http(self) -> axum::response::Response {
        let (status, error) = match &self {
            UserTokenFetchError::PermissionRequired(_) => {
                (StatusCode::FORBIDDEN, "permission_required")
            }
            UserTokenFetchError::Disabled(_) => {
                (StatusCode::SERVICE_UNAVAILABLE, "user_oauth_disabled")
            }
            UserTokenFetchError::ApiError(s, _) => (
                StatusCode::from_u16(*s).unwrap_or(StatusCode::BAD_GATEWAY),
                "api_error",
            ),
            UserTokenFetchError::Transport(_) => {
                (StatusCode::BAD_GATEWAY, "api_unreachable")
            }
            UserTokenFetchError::Parse(_) => {
                (StatusCode::BAD_GATEWAY, "api_response_invalid")
            }
        };
        let message = match self {
            UserTokenFetchError::PermissionRequired(m)
            | UserTokenFetchError::Disabled(m)
            | UserTokenFetchError::ApiError(_, m)
            | UserTokenFetchError::Transport(m)
            | UserTokenFetchError::Parse(m) => m,
        };
        axum::response::IntoResponse::into_response((
            status,
            Json(UserTokenError {
                error: error.to_string(),
                message: Some(message),
            }),
        ))
    }
}
