//! Graph + vector provider bridge for agents.
//!
//! The agent calls `/graph/*` and `/vector/*` on the sidecar. The
//! sidecar does NATS request/reply on `x1.provider.graph.*` /
//! `x1.provider.vector.*` with a 10s timeout and relays the reply
//! verbatim. Before forwarding, the sidecar validates the collection
//! the agent named is actually attached to this session's agent —
//! the attached list lives in AGENT_COLLECTIONS_JSON env on pod boot.
//!
//! Agents can pass the collection as either a slug ("ideas") or the
//! provider-opaque backend handle ("col_default_ideas"). The sidecar
//! normalises to the handle before it hits NATS so the provider gets
//! a consistent input.

use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use once_cell::sync::Lazy;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use crate::AppState;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AttachedCollection {
    pub id: String,
    pub slug: String,
    pub backend_handle: String,
    /// Per-workspace SurrealDB namespace (ws_<slug>). The sidecar
    /// relays it on every NATS call so the provider pins `surreal-ns`
    /// for tenancy isolation. Optional during the rollout window so
    /// pre-Layer-2 jobs still parse cleanly; absent => empty string
    /// downstream and the provider falls back to the install bootstrap
    /// namespace (pre-existing behavior). See t03 P0 #2 Layer 2.
    #[serde(default)]
    pub backend_namespace: String,
    pub provider_type: String,
    #[serde(default)]
    pub is_default: bool,
}

static ATTACHED_COLLECTIONS: Lazy<Vec<AttachedCollection>> = Lazy::new(|| {
    match std::env::var("AGENT_COLLECTIONS_JSON") {
        Ok(raw) if !raw.is_empty() => {
            serde_json::from_str::<Vec<AttachedCollection>>(&raw).unwrap_or_else(|e| {
                tracing::warn!("AGENT_COLLECTIONS_JSON parse failed: {}", e);
                Vec::new()
            })
        }
        _ => Vec::new(),
    }
});

/// (workspace_namespace, backend_handle) pair — the full address of a
/// collection's backing store. See t03 P0 #2 Layer 2.
struct ResolvedCollection {
    namespace: String,
    handle: String,
}

/// Resolve a caller-supplied `collection` string to its full address.
/// Matches on id, slug, or handle. If no `collection` is supplied,
/// returns the default attachment.
fn resolve_collection(collection: Option<&str>) -> Option<ResolvedCollection> {
    let attached = &*ATTACHED_COLLECTIONS;
    let pick = |a: &AttachedCollection| ResolvedCollection {
        namespace: a.backend_namespace.clone(),
        handle: a.backend_handle.clone(),
    };
    if let Some(c) = collection {
        return attached
            .iter()
            .find(|a| a.id == c || a.slug == c || a.backend_handle == c)
            .map(pick);
    }
    attached.iter().find(|a| a.is_default).map(pick)
}

#[derive(Serialize)]
pub struct ErrorBody {
    pub ok: bool,
    pub error: ErrorDetails,
}
#[derive(Serialize)]
pub struct ErrorDetails {
    pub code: String,
    pub message: String,
}

fn error_response(
    status: StatusCode,
    code: &str,
    message: &str,
) -> axum::response::Response {
    (
        status,
        Json(ErrorBody {
            ok: false,
            error: ErrorDetails {
                code: code.into(),
                message: message.into(),
            },
        }),
    )
        .into_response()
}

/// Core NATS request/reply; callers supply the subject + the already-
/// shaped JSON body (with `handle` / `namespace` field replaced by the
/// resolved handle).
async fn nats_request(
    state: &AppState,
    subject: &str,
    body: serde_json::Value,
) -> axum::response::Response {
    let payload = match serde_json::to_vec(&body) {
        Ok(b) => b,
        Err(e) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "encode_failed",
                &e.to_string(),
            )
        }
    };
    let subject_owned = subject.to_string();
    let res = tokio::time::timeout(
        Duration::from_secs(10),
        state.nc.request(subject_owned, payload.into()),
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
            "graph/vector provider did not reply within 10s",
        ),
    }
}

// ── Graph request shapes ─────────────────────────────────────────

#[derive(Deserialize)]
pub struct GraphQueryRequest {
    #[serde(default)]
    pub collection: Option<String>,
    pub query: String,
    #[serde(default)]
    pub vars: serde_json::Value,
}

#[derive(Deserialize)]
pub struct GraphWriteRequest {
    #[serde(default)]
    pub collection: Option<String>,
    pub record_type: String,
    pub data: serde_json::Value,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub derived_from: Vec<String>,
}
fn default_confidence() -> f64 {
    1.0
}

#[derive(Deserialize)]
pub struct GraphRelateRequest {
    #[serde(default)]
    pub collection: Option<String>,
    pub from: String,
    pub edge: String,
    pub to: String,
    #[serde(default)]
    pub properties: serde_json::Value,
}

#[derive(Deserialize)]
pub struct GraphResolveRequest {
    #[serde(default)]
    pub collection: Option<String>,
    pub record_type: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub attributes: serde_json::Value,
}

#[derive(Deserialize)]
pub struct GraphDiscoverRequest {
    #[serde(default)]
    pub collection: Option<String>,
}

// ── Graph handlers ───────────────────────────────────────────────

fn require_address(
    collection: Option<&str>,
) -> Result<ResolvedCollection, axum::response::Response> {
    match resolve_collection(collection) {
        Some(addr) => Ok(addr),
        None => Err(error_response(
            StatusCode::NOT_FOUND,
            "collection_not_attached",
            "the agent is not attached to the requested collection",
        )),
    }
}

pub async fn handle_graph_query(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GraphQueryRequest>,
) -> axum::response::Response {
    let addr = match require_address(req.collection.as_deref()) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "namespace": addr.namespace,
        "handle": addr.handle,
        "query": req.query,
        "vars": req.vars,
    });
    nats_request(&state, "x1.provider.graph.query", body).await
}

pub async fn handle_graph_write(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GraphWriteRequest>,
) -> axum::response::Response {
    let addr = match require_address(req.collection.as_deref()) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let user_id = std::env::var("SESSION_USER_ID").ok();
    let provenance = serde_json::json!({
        "session_id": state.session_id,
        "user_id": user_id,
        "confidence": req.confidence,
        "source": req.source,
        "derived_from": req.derived_from,
    });
    let body = serde_json::json!({
        "namespace": addr.namespace,
        "handle": addr.handle,
        "record_type": req.record_type,
        "data": req.data,
        "provenance": provenance,
    });
    nats_request(&state, "x1.provider.graph.write", body).await
}

pub async fn handle_graph_relate(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GraphRelateRequest>,
) -> axum::response::Response {
    let addr = match require_address(req.collection.as_deref()) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "namespace": addr.namespace,
        "handle": addr.handle,
        "from": req.from,
        "edge": req.edge,
        "to": req.to,
        "properties": req.properties,
    });
    nats_request(&state, "x1.provider.graph.relate", body).await
}

pub async fn handle_graph_resolve(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GraphResolveRequest>,
) -> axum::response::Response {
    let addr = match require_address(req.collection.as_deref()) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "namespace": addr.namespace,
        "handle": addr.handle,
        "record_type": req.record_type,
        "name": req.name,
        "email": req.email,
        "attributes": req.attributes,
    });
    nats_request(&state, "x1.provider.graph.resolve", body).await
}

pub async fn handle_graph_discover(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GraphDiscoverRequest>,
) -> axum::response::Response {
    let addr = match require_address(req.collection.as_deref()) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "namespace": addr.namespace,
        "handle": addr.handle,
    });
    nats_request(&state, "x1.provider.graph.discover", body).await
}

// ── Vector ───────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct VectorUpsertRequest {
    #[serde(default)]
    pub collection: Option<String>,
    pub id: String,
    pub vector: Vec<f64>,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Deserialize)]
pub struct VectorSearchRequest {
    #[serde(default)]
    pub collection: Option<String>,
    pub vector: Vec<f64>,
    #[serde(default = "default_top_k")]
    pub top_k: u32,
    #[serde(default)]
    pub filter: serde_json::Value,
}
fn default_top_k() -> u32 {
    10
}

#[derive(Deserialize)]
pub struct VectorDeleteRequest {
    #[serde(default)]
    pub collection: Option<String>,
    pub id: String,
}

pub async fn handle_vector_upsert(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VectorUpsertRequest>,
) -> axum::response::Response {
    let addr = match require_address(req.collection.as_deref()) {
        Ok(a) => a,
        Err(r) => return r,
    };
    // Wire shape (Layer 2): `namespace` carries the workspace
    // SurrealDB namespace (ws_<slug>); `handle` carries the
    // per-collection database name. Pre-Layer-2 the field name was
    // overloaded — `namespace` used to mean the collection's db.
    let body = serde_json::json!({
        "namespace": addr.namespace,
        "handle": addr.handle,
        "id": req.id,
        "vector": req.vector,
        "metadata": req.metadata,
    });
    nats_request(&state, "x1.provider.vector.upsert", body).await
}

pub async fn handle_vector_search(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VectorSearchRequest>,
) -> axum::response::Response {
    let addr = match require_address(req.collection.as_deref()) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "namespace": addr.namespace,
        "handle": addr.handle,
        "vector": req.vector,
        "top_k": req.top_k,
        "filter": req.filter,
    });
    nats_request(&state, "x1.provider.vector.search", body).await
}

pub async fn handle_vector_delete(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VectorDeleteRequest>,
) -> axum::response::Response {
    let addr = match require_address(req.collection.as_deref()) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let body = serde_json::json!({
        "namespace": addr.namespace,
        "handle": addr.handle,
        "id": req.id,
    });
    nats_request(&state, "x1.provider.vector.delete", body).await
}

// Expose the attached-collections list so the agent can render "which
// collection am I writing to" without hitting the API.
pub async fn handle_list_collections() -> axum::response::Response {
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "collections": &*ATTACHED_COLLECTIONS,
        })),
    )
        .into_response()
}
