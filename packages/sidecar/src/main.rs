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
mod channel;
mod git;
mod collections;
mod messaging;
mod nats_bridge;
mod orchestration;
mod shares;
mod stream;

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

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

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
            "/messaging/post_message",
            routing::post(messaging::handle_post_message),
        )
        .route("/share", routing::post(shares::handle_share))
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
