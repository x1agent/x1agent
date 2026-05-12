//! x1agent sidecar — trust boundary for the session pod.
//!
//! Responsibilities:
//!   - Bridge the agent's SSE stream on :3100 to NATS
//!     (`x1.session.{id}.events`).
//!   - Subscribe to `x1.session.{id}.input` and POST to the agent's
//!     `/inject` endpoint.
//!   - Serve `/git/credential` to the agent's git credential helper —
//!     the sidecar holds the API's internal token and exchanges it for
//!     a GitHub App installation token on demand.
//!   - Clone any repos configured in AGENT_REPOS_JSON into /workspace
//!     at startup, checking out (or creating) the specified branch.

use async_nats::Client as NatsClient;
use axum::{extract::State, routing, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

mod audit;
mod calendar;
mod channel;
mod cost;
mod docs;
mod email;
mod files;
mod git;
mod collections;
mod messaging;
mod nats_bridge;
mod orchestration;
mod sheets;
mod share_comments;
mod shares;
mod stream;
mod user_tokens;

#[derive(Clone)]
pub struct AppState {
    pub nc: NatsClient,
    pub session_id: String,
    /// Workspace slug — used to scope API calls like
    /// `/api/workspaces/{slug}/internal/...`.
    pub workspace_slug: String,
    pub sequence: Arc<AtomicU64>,
    /// URL of the agent container's inject + keepalive endpoint
    /// (`:8788` by convention).
    pub channel_url: String,
    /// URL of the agent container's SSE stream (`:3100`).
    pub agent_stream_url: String,
    /// URL of the api service (cluster-internal). Used to mint
    /// installation tokens and forward events for durable storage.
    pub api_url: String,
    /// Shared-secret header the api expects on internal endpoints.
    pub api_internal_token: String,
}

#[derive(Deserialize)]
struct EventPayload {
    r#type: String,
    payload: serde_json::Value,
}

/// Wire message envelope. Matches what the UI consumes from NATS.
#[derive(Serialize)]
pub struct SessionMessage {
    pub session_id: String,
    pub timestamp: String,
    pub sequence: u64,
    pub r#type: String,
    pub payload: serde_json::Value,
}

// Sentry init returns a guard that flushes pending events on drop.
// Must outlive every code path in main, so we hold it in a local for
// the entire main body. No-op when SENTRY_DSN_SIDECAR is unset.
fn init_sentry() -> Option<sentry::ClientInitGuard> {
    let dsn = std::env::var("SENTRY_DSN_SIDECAR").ok()?;
    if dsn.trim().is_empty() {
        return None;
    }
    let release = std::env::var("SENTRY_RELEASE")
        .ok()
        .or_else(|| std::env::var("IMAGE_TAG").ok())
        .map(std::borrow::Cow::Owned);
    let environment = std::env::var("SENTRY_ENVIRONMENT")
        .unwrap_or_else(|_| "production".into());
    let guard = sentry::init((
        dsn,
        sentry::ClientOptions {
            release,
            environment: Some(environment.into()),
            send_default_pii: true,
            ..Default::default()
        },
    ));
    eprintln!("[sentry] sidecar initialised");
    Some(guard)
}

#[tokio::main]
async fn main() {
    // Holding the guard for the duration of main keeps the Sentry
    // transport alive; drop happens at process exit and flushes.
    let _sentry_guard = init_sentry();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Verify route hatch — `SIDECAR_DEBUG_PANIC=1` triggers a panic on
    // boot so we can verify Sentry receives the first event end-to-end
    // without waiting for an organic crash.
    if std::env::var("SIDECAR_DEBUG_PANIC").as_deref() == Ok("1") {
        panic!("x1agent sidecar: first Sentry event");
    }

    let session_id = std::env::var("SESSION_ID").expect("SESSION_ID required");
    let workspace_slug = std::env::var("SESSION_WORKSPACE_SLUG").unwrap_or_default();
    let nats_url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://nats:4222".into());
    let channel_url =
        std::env::var("CHANNEL_URL").unwrap_or_else(|_| "http://localhost:8788".into());
    let agent_stream_url =
        std::env::var("AGENT_STREAM_URL").unwrap_or_else(|_| "http://localhost:3100".into());
    let api_url = std::env::var("API_URL").unwrap_or_else(|_| "http://api:30001".into());
    let api_internal_token = std::env::var("API_INTERNAL_TOKEN").unwrap_or_default();

    // Clone agent-configured repos before the agent begins its work.
    // Errors are non-fatal: the session still runs, just without repos.
    if !workspace_slug.is_empty() {
        match git::clone_repos(&api_url, &api_internal_token, &workspace_slug).await {
            Ok(0) => {}
            Ok(n) => tracing::info!("git: cloned {} repos", n),
            Err(e) => tracing::warn!("git: clone failed (continuing): {}", e),
        }
    }

    let nc = nats_bridge::connect_with_retry(&nats_url, 30).await;
    tracing::info!("Connected to NATS at {}", nats_url);

    let state = Arc::new(AppState {
        nc: nc.clone(),
        session_id: session_id.clone(),
        workspace_slug: workspace_slug.clone(),
        sequence: Arc::new(AtomicU64::new(0)),
        channel_url,
        agent_stream_url,
        api_url,
        api_internal_token,
    });

    let s = state.clone();
    tokio::spawn(async move {
        if let Err(e) = channel::input_subscriber(s).await {
            tracing::error!("Input subscriber error: {}", e);
        }
    });

    let s = state.clone();
    tokio::spawn(async move {
        if let Err(e) = channel::presence_subscriber(s).await {
            tracing::error!("Presence subscriber error: {}", e);
        }
    });

    let s = state.clone();
    tokio::spawn(async move {
        if let Err(e) = stream::agent_stream_consumer(s).await {
            tracing::error!("Agent stream consumer error: {}", e);
        }
    });

    let app = Router::new()
        .route("/event", routing::post(handle_event))
        .route("/git/credential", routing::get(git::handle_git_credential))
        .route(
            "/user-oauth-token",
            routing::get(user_tokens::handle_user_token),
        )
        .route("/spawn", routing::post(orchestration::handle_spawn))
        .route("/spawnable", routing::get(orchestration::handle_spawnable))
        .route(
            "/child/{child_id}/events",
            routing::get(orchestration::handle_read_child),
        )
        .route(
            "/child/{child_id}/inject",
            routing::post(orchestration::handle_inject_child),
        )
        .route(
            "/message-caller",
            routing::post(orchestration::handle_message_caller),
        )
        .route(
            "/quiet-hint",
            routing::post(orchestration::handle_quiet_hint),
        )
        .route(
            "/preview/deploy",
            routing::post(orchestration::handle_preview_deploy),
        )
        .route(
            "/messaging/post_message",
            routing::post(messaging::handle_post_message),
        )
        .route("/files/list", routing::post(files::handle_list))
        .route("/files/get", routing::post(files::handle_get))
        .route("/files/download", routing::post(files::handle_download))
        .route("/files/upload", routing::post(files::handle_upload))
        .route(
            "/files/update_content",
            routing::post(files::handle_update_content),
        )
        .route(
            "/files/update_metadata",
            routing::post(files::handle_update_metadata),
        )
        .route(
            "/files/create_folder",
            routing::post(files::handle_create_folder),
        )
        .route("/files/trash", routing::post(files::handle_trash))
        // Sheets
        .route(
            "/sheets/read_range",
            routing::post(sheets::handle_read_range),
        )
        .route(
            "/sheets/update_range",
            routing::post(sheets::handle_update_range),
        )
        .route(
            "/sheets/append_row",
            routing::post(sheets::handle_append_row),
        )
        .route("/sheets/create", routing::post(sheets::handle_create))
        // Docs
        .route("/docs/read", routing::post(docs::handle_read))
        .route("/docs/create", routing::post(docs::handle_create))
        .route(
            "/docs/replace_text",
            routing::post(docs::handle_replace_text),
        )
        .route(
            "/docs/append_paragraph",
            routing::post(docs::handle_append_paragraph),
        )
        // Calendar
        .route(
            "/calendar/list_events",
            routing::post(calendar::handle_list_events),
        )
        .route(
            "/calendar/create_event",
            routing::post(calendar::handle_create_event),
        )
        .route(
            "/calendar/update_event",
            routing::post(calendar::handle_update_event),
        )
        .route(
            "/calendar/delete_event",
            routing::post(calendar::handle_delete_event),
        )
        // Email (Gmail)
        .route(
            "/email/list_threads",
            routing::post(email::handle_list_threads),
        )
        .route(
            "/email/get_message",
            routing::post(email::handle_get_message),
        )
        .route("/email/send", routing::post(email::handle_send))
        .route("/email/trash", routing::post(email::handle_trash))
        .route("/share", routing::post(shares::handle_share))
        // Doc commenting v1 (X1A-52). Sidecar is the trust boundary —
        // the MCP `share_comment` + `share_comment_resolve` tools POST
        // here, the sidecar adds X-Internal-Token and forwards to
        // /api/internal/share-comments. IDOR + NATS publication live on
        // the api side.
        .route(
            "/share_comment",
            routing::post(share_comments::handle_share_comment),
        )
        .route(
            "/share_comment_resolve",
            routing::post(share_comments::handle_share_comment_resolve),
        )
        .route(
            "/collections",
            routing::get(collections::handle_list_collections),
        )
        .route("/graph/query", routing::post(collections::handle_graph_query))
        .route("/graph/write", routing::post(collections::handle_graph_write))
        .route(
            "/graph/relate",
            routing::post(collections::handle_graph_relate),
        )
        .route(
            "/graph/resolve",
            routing::post(collections::handle_graph_resolve),
        )
        .route(
            "/graph/discover",
            routing::post(collections::handle_graph_discover),
        )
        .route(
            "/vector/upsert",
            routing::post(collections::handle_vector_upsert),
        )
        .route(
            "/vector/search",
            routing::post(collections::handle_vector_search),
        )
        .route(
            "/vector/delete",
            routing::post(collections::handle_vector_delete),
        )
        // X1A-37 — cost surfacing. Three GETs forwarded to the api's
        // internal /sessions/:id/cost{,-tree,-agent} endpoints with
        // the agent's session_id supplied here (the agent never names
        // a session in its MCP tool args).
        .route("/cost/session", routing::get(cost::handle_session_cost))
        .route(
            "/cost/session-tree",
            routing::get(cost::handle_session_tree_cost),
        )
        .route("/cost/agent", routing::get(cost::handle_agent_cost))
        .route("/health", routing::get(|| async { "ok" }))
        // Audit middleware emits one NATS message per request (denylist
        // for /health and /event). The api side persists those into
        // audit_events.
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            audit::audit_layer,
        ))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:9090")
        .await
        .expect("bind :9090");
    tracing::info!("Sidecar HTTP listening on :9090");
    axum::serve(listener, app).await.expect("serve");
}

async fn handle_event(
    State(state): State<Arc<AppState>>,
    Json(event): Json<EventPayload>,
) -> &'static str {
    nats_bridge::publish_event(&state, &event.r#type, event.payload).await;
    "ok"
}
