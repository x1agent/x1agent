//! Git credential proxy + startup repo cloning.
//!
//! Flow:
//!   1. At startup, the sidecar reads `AGENT_REPOS_JSON` and clones each
//!      repo to `/workspace/<mount_path>`, checking out the configured
//!      branch. If the branch doesn't exist on the remote, the sidecar
//!      creates it locally off the repo's default HEAD — the first push
//!      establishes it upstream.
//!   2. At runtime, `/git/credential` answers git's credential helper
//!      protocol with a username/password pair fetched from the api's
//!      `/api/internal/git-credential` endpoint.

use axum::extract::{Query, State};
use axum::Json;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tokio::process::Command;

use crate::AppState;

// ── Types ─────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RepoConfig {
    /// owner/repo
    pub repo_full_name: String,
    pub branch: String,
    pub mount_path: String,
    #[serde(default)]
    pub auto_push: bool,
    pub installation_id: u64,
}

#[derive(Deserialize)]
pub struct CredentialQuery {
    /// Git passes `host=` from the credential-helper protocol. Unused
    /// today but kept for future per-host scoping.
    #[serde(default)]
    #[allow(dead_code)]
    pub host: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Serialize)]
pub struct CredentialResponse {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct TokenOnlyResponse {
    pub token: String,
}

#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub message: String,
}

// ── Credential endpoint ───────────────────────────────────

pub async fn handle_git_credential(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CredentialQuery>,
) -> axum::response::Response {
    let Some(installation_id) = installation_for_runtime(&state).await else {
        return error_response(
            StatusCode::BAD_GATEWAY,
            "no_installation",
            "No installation is configured for this session — attach a repo first.",
        );
    };

    let (username, token) = match fetch_git_token(
        &state.api_url,
        &state.api_internal_token,
        installation_id,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("git_credential: token fetch failed: {}", e);
            return error_response(
                StatusCode::BAD_GATEWAY,
                "credential_fetch_failed",
                &e.to_string(),
            );
        }
    };

    if params.format.as_deref() == Some("token") {
        return axum::response::IntoResponse::into_response((
            StatusCode::OK,
            Json(TokenOnlyResponse { token }),
        ));
    }

    axum::response::IntoResponse::into_response((
        StatusCode::OK,
        Json(CredentialResponse {
            username,
            password: token,
        }),
    ))
}

/// Pick an installation for a runtime credential request. If the session
/// has repos configured, use the first one's installation (all repos on
/// an agent share a single installation, so any works). Otherwise fall
/// back to `AGENT_INSTALLATION_ID` if set.
async fn installation_for_runtime(_state: &AppState) -> Option<u64> {
    if let Ok(repos_json) = std::env::var("AGENT_REPOS_JSON") {
        if let Ok(repos) = serde_json::from_str::<Vec<RepoConfig>>(&repos_json) {
            if let Some(first) = repos.first() {
                return Some(first.installation_id);
            }
        }
    }
    std::env::var("AGENT_INSTALLATION_ID")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
}

async fn fetch_git_token(
    api_url: &str,
    internal_token: &str,
    installation_id: u64,
) -> Result<(String, String), Box<dyn std::error::Error>> {
    let url = format!(
        "{}/api/internal/git-credential?installation_id={}",
        api_url.trim_end_matches('/'),
        installation_id
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("X-Internal-Token", internal_token)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("api returned {} — {}", status, body).into());
    }
    #[derive(Deserialize)]
    struct R {
        username: String,
        token: String,
    }
    let r: R = resp.json().await?;
    Ok((r.username, r.token))
}

fn error_response(
    status: StatusCode,
    error: &str,
    message: &str,
) -> axum::response::Response {
    axum::response::IntoResponse::into_response((
        status,
        Json(ErrorResponse {
            error: error.to_string(),
            message: message.to_string(),
        }),
    ))
}

// ── Startup clone ─────────────────────────────────────────

pub async fn clone_repos(
    api_url: &str,
    internal_token: &str,
    _workspace_slug: &str,
) -> Result<usize, String> {
    let repos_json = std::env::var("AGENT_REPOS_JSON").unwrap_or_default();
    if repos_json.is_empty() || repos_json == "[]" {
        return Ok(0);
    }
    let repos: Vec<RepoConfig> = serde_json::from_str(&repos_json)
        .map_err(|e| format!("AGENT_REPOS_JSON parse: {}", e))?;
    if repos.is_empty() {
        return Ok(0);
    }

    let mut cloned = 0usize;
    for repo in &repos {
        let (username, token) = match fetch_git_token(api_url, internal_token, repo.installation_id)
            .await
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(
                    "git: credential fetch failed for {}: {}",
                    repo.repo_full_name,
                    e
                );
                continue;
            }
        };
        match clone_single(repo, &username, &token).await {
            Ok(()) => {
                tracing::info!(
                    "git: ready {} on {} → /workspace/{}",
                    repo.repo_full_name,
                    repo.branch,
                    repo.mount_path
                );
                cloned += 1;
            }
            Err(e) => tracing::error!("git: clone {} failed: {}", repo.repo_full_name, e),
        }
    }
    Ok(cloned)
}

async fn clone_single(repo: &RepoConfig, username: &str, token: &str) -> Result<(), String> {
    let target = format!("/workspace/{}", repo.mount_path);
    let target_path = Path::new(&target);

    if target_path.join(".git").exists() {
        return refresh_existing(&target, &repo.branch).await;
    }

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }

    let https_url = format!("https://github.com/{}.git", repo.repo_full_name);
    let authed = inject_credentials(&https_url, username, token)?;

    // First attempt: clone the requested branch directly (fast path when
    // the branch exists remotely).
    let output = Command::new("git")
        .args([
            "clone",
            "--depth=1",
            &format!("--branch={}", repo.branch),
            "--single-branch",
            &authed,
            &target,
        ])
        .output()
        .await
        .map_err(|e| format!("spawn git clone: {}", e))?;

    if !output.status.success() {
        // Branch not present remotely — clone default HEAD, then create
        // the branch locally.
        let fallback = Command::new("git")
            .args(["clone", "--depth=1", &authed, &target])
            .output()
            .await
            .map_err(|e| format!("fallback clone: {}", e))?;
        if !fallback.status.success() {
            let stderr = String::from_utf8_lossy(&fallback.stderr);
            return Err(format!("git clone failed: {}", stderr));
        }
        let branch_out = Command::new("git")
            .args(["-C", &target, "checkout", "-b", &repo.branch])
            .output()
            .await
            .map_err(|e| format!("git checkout -b: {}", e))?;
        if !branch_out.status.success() {
            let stderr = String::from_utf8_lossy(&branch_out.stderr);
            return Err(format!("git checkout -b failed: {}", stderr));
        }
        tracing::info!(
            "git: branch {} did not exist remotely — created locally",
            repo.branch
        );
    }

    // Point `origin` at the plain HTTPS URL; subsequent operations use
    // the credential helper so tokens don't live in git config.
    let _ = Command::new("git")
        .args([
            "-C",
            &target,
            "remote",
            "set-url",
            "origin",
            &https_url,
        ])
        .output()
        .await;

    // The sidecar and agent both run as uid 1000 (see the sidecar
    // Dockerfile and the pod-spec securityContext). Files cloned
    // here are already owned by 1000:1000, so the agent can read
    // and write directly with no chown / chmod dance.

    Ok(())
}

async fn refresh_existing(target: &str, branch: &str) -> Result<(), String> {
    let out = Command::new("git")
        .args(["-C", target, "fetch", "--depth=1", "origin", branch])
        .output()
        .await
        .map_err(|e| format!("git fetch: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git fetch failed: {}", stderr));
    }
    let out = Command::new("git")
        .args(["-C", target, "checkout", &format!("origin/{}", branch)])
        .output()
        .await
        .map_err(|e| format!("git checkout: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git checkout failed: {}", stderr));
    }
    Ok(())
}

/// Fold username:token into an https:// URL for a one-shot clone.
fn inject_credentials(url: &str, username: &str, token: &str) -> Result<String, String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("unsupported URL (expected https://): {}", url))?;
    Ok(format!(
        "https://{}:{}@{}",
        urlencoding::encode(username),
        urlencoding::encode(token),
        rest,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_credentials_basic() {
        let r = inject_credentials("https://github.com/x1agent/x1agent", "x-access-token", "ghs_abc").unwrap();
        assert_eq!(r, "https://x-access-token:ghs_abc@github.com/x1agent/x1agent");
    }

    #[test]
    fn inject_credentials_with_dotgit() {
        let r = inject_credentials("https://github.com/x/y.git", "u", "t").unwrap();
        assert_eq!(r, "https://u:t@github.com/x/y.git");
    }

    #[test]
    fn inject_credentials_rejects_ssh() {
        assert!(inject_credentials("git@github.com:x/y.git", "u", "t").is_err());
    }

    #[test]
    fn inject_credentials_encodes_special_chars() {
        let r = inject_credentials("https://github.com/x/y", "u", "tok/en+=").unwrap();
        assert!(r.contains("tok%2Fen%2B%3D"));
    }

    #[test]
    fn parse_repo_config_shape() {
        let j = r#"[{
            "repo_full_name": "acme/frontend",
            "branch": "main",
            "mount_path": "frontend",
            "installation_id": 1234
        }]"#;
        let repos: Vec<RepoConfig> = serde_json::from_str(j).unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].repo_full_name, "acme/frontend");
        assert_eq!(repos[0].installation_id, 1234);
        assert!(!repos[0].auto_push);
    }
}
