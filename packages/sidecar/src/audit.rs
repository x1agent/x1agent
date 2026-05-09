//! Sidecar audit middleware.
//!
//! Wraps every axum route. After the handler runs we publish one
//! NATS message on `x1.session.{id}.audit` with the method, route,
//! and status. The api subscribes to that subject in
//! startSessionAuditSubscriber and persists rows into audit_events.
//!
//! Wave 2 of rfcs/jetstream-migration.md routes the publish through
//! the same JetStream-aware `publish_with_dedup` helper that wakes
//! use, so audit records get the broker's durable storage and
//! msg-id dedup window when USE_JETSTREAM_PUBLISH=true. Falls back
//! to NATS-core otherwise. The api-side audit subscriber stays on
//! NATS-core for now -- moving it to a durable JetStream consumer
//! is the archiver follow-up.
//!
//! Skipped routes:
//!   - /health: kubelet probe, would fill the audit table with
//!     useless rows
//!   - /event: agent-emitted display events (status, artifact). Those
//!     already land in session_events; auditing them too is noise.

use async_nats::Client as NatsClient;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use std::sync::Arc;

use crate::AppState;
use crate::channel::publish_with_dedup;

const AUDIT_DENYLIST: &[&str] = &["/health", "/event"];

pub async fn audit_layer(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();

    let response = next.run(request).await;
    let status = response.status();

    if !AUDIT_DENYLIST.iter().any(|d| path == *d) {
        publish_audit(&state.nc, &state.session_id, &method.to_string(), &path, status)
            .await;
    }

    response
}

async fn publish_audit(
    nc: &NatsClient,
    session_id: &str,
    method: &str,
    route: &str,
    status: StatusCode,
) {
    let ts = chrono::Utc::now().to_rfc3339();
    let body = serde_json::json!({
        "session_id": session_id,
        "ts": ts,
        "method": method,
        "route": route,
        "status": status.as_u16(),
    });
    let payload = match serde_json::to_vec(&body) {
        Ok(b) => bytes::Bytes::from(b),
        Err(_) => return,
    };
    let subject = format!("x1.session.{}.audit", session_id);
    // (session, method, route, ts) is unique per call: the timestamp
    // is generated inside this function so a publisher retry of the
    // same logical audit event reuses it. The sidecar runs single-
    // threaded per pod, so this is collision-safe within the 2-minute
    // duplicate window without needing a per-call uuid.
    let msg_id = format!("audit.{}.{}.{}.{}", session_id, method, route, ts);
    if let Err(e) = publish_with_dedup(nc, subject, payload, &msg_id).await {
        tracing::warn!("audit publish failed: {}", e);
    }
}
