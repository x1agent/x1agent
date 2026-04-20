//! Share subsystem — the agent asks the sidecar to publish a file or
//! folder from `/workspace` so the user can view or download it in the
//! session viewer.
//!
//! Flow:
//!   1. Agent calls `share(path, title?)` via the x1agent MCP tool.
//!   2. MCP server POSTs `/share` to the sidecar (this file).
//!   3. Sidecar reads the file(s), detects the share type, uploads the
//!      bytes to durable storage (GCS in prod, api service in local
//!      dev), and publishes an `agent.share` NATS event.
//!   4. The browser session viewer receives the event and renders a
//!      ShareCard with a type-specific view (image, iframe, table,
//!      tree, etc).
//!
//! The `/workspace` root is enforced — canonical paths must stay under
//! it so a buggy or malicious agent cannot exfiltrate host files.

use crate::AppState;
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const WORKSPACE_ROOT: &str = "/workspace";
const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024; // 50 MB per file
const MAX_TOTAL_SIZE: u64 = 200 * 1024 * 1024; // 200 MB per share

#[derive(Deserialize)]
pub struct ShareRequest {
    pub path: String,
    pub title: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ShareFileEntry {
    pub path: String,
    pub size: u64,
    pub content_type: String,
}

#[derive(Serialize)]
pub struct ShareResponse {
    pub ok: bool,
    pub share_id: String,
    pub share_type: String,
    pub title: String,
    pub files: Vec<ShareFileEntry>,
    pub total_size: u64,
    pub entry_point: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Map a collected file set to one of nine share types. A folder with
/// `index.html` is a "site" (iframe). A single `.html`/`.htm` is also
/// a site but the file itself is the entry point. Otherwise we dispatch
/// on the file extension of a single file; for a folder without
/// `index.html` we fall back to `file`.
fn detect_share_type(files: &[ShareFileEntry], is_dir: bool) -> (String, Option<String>) {
    if is_dir {
        if files.iter().any(|f| f.path == "index.html") {
            return ("site".into(), Some("index.html".into()));
        }
        return ("file".into(), None);
    }

    let path = &files[0].path;
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" | "htm" => ("site".into(), Some(path.clone())),
        "png" | "jpg" | "jpeg" | "gif" | "webp" => ("image".into(), None),
        "svg" => ("svg".into(), None),
        "csv" => ("csv".into(), None),
        "json" | "jsonl" => ("json".into(), None),
        "zip" | "tar" | "gz" | "tgz" => ("archive".into(), None),
        "md" => ("document".into(), None),
        "ts" | "tsx" | "js" | "jsx" | "py" | "rs" | "go" | "java" | "rb" | "sql" | "sh"
        | "yaml" | "yml" | "toml" | "css" => ("code".into(), None),
        _ => ("file".into(), None),
    }
}

fn guess_content_type(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "jsonl" => "application/jsonl",
        "csv" => "text/csv",
        "md" => "text/markdown",
        "txt" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "ts" | "tsx" => "text/typescript",
        "py" => "text/x-python",
        "rs" => "text/x-rust",
        "sql" => "text/x-sql",
        "yaml" | "yml" => "text/yaml",
        "toml" => "text/toml",
        "sh" => "text/x-shellscript",
        "xml" => "text/xml",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
    .into()
}

/// Read a single file or walk a directory and return
/// `(relative path, bytes, entry)` tuples. A single-file share stores
/// the file's basename as its relative path; a directory share uses
/// paths relative to the directory root.
fn collect_files(
    abs_path: &Path,
    _base: &Path,
) -> Result<Vec<(String, Vec<u8>, ShareFileEntry)>, String> {
    let mut result = Vec::new();
    let mut total_size: u64 = 0;

    if abs_path.is_file() {
        let size = abs_path.metadata().map(|m| m.len()).unwrap_or(0);
        if size > MAX_FILE_SIZE {
            return Err(format!(
                "File too large: {} ({} bytes, max {})",
                abs_path.display(),
                size,
                MAX_FILE_SIZE
            ));
        }
        let content = std::fs::read(abs_path)
            .map_err(|e| format!("Failed to read {}: {}", abs_path.display(), e))?;
        let rel = abs_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ct = guess_content_type(&rel);
        result.push((
            rel.clone(),
            content,
            ShareFileEntry {
                path: rel,
                size,
                content_type: ct,
            },
        ));
    } else if abs_path.is_dir() {
        collect_dir_recursive(abs_path, abs_path, &mut result, &mut total_size)?;
    } else {
        return Err(format!("Path not found: {}", abs_path.display()));
    }

    Ok(result)
}

fn collect_dir_recursive(
    root: &Path,
    dir: &Path,
    result: &mut Vec<(String, Vec<u8>, ShareFileEntry)>,
    total_size: &mut u64,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read dir {}: {}", dir.display(), e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Skip hidden dirs and the usual vendored junk — a share
            // with 80k node_modules files would blow through the total
            // size cap instantly and isn't what any user wants anyway.
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with('.') || name == "node_modules" || name == "__pycache__" {
                continue;
            }
            collect_dir_recursive(root, &path, result, total_size)?;
        } else {
            let size = path.metadata().map(|m| m.len()).unwrap_or(0);
            if size > MAX_FILE_SIZE {
                continue;
            }
            *total_size += size;
            if *total_size > MAX_TOTAL_SIZE {
                return Err("Total share size exceeds limit".into());
            }
            let content = match std::fs::read(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            let ct = guess_content_type(&rel);
            result.push((
                rel.clone(),
                content,
                ShareFileEntry {
                    path: rel,
                    size,
                    content_type: ct,
                },
            ));
        }
    }
    Ok(())
}

/// POST /share — share a file or folder from `/workspace`.
pub async fn handle_share(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ShareRequest>,
) -> Result<Json<ShareResponse>, (StatusCode, Json<ShareResponse>)> {
    let workspace = PathBuf::from(WORKSPACE_ROOT);
    let abs_path = workspace.join(&req.path);

    // canonicalize() resolves symlinks and `..` segments; if the result
    // climbs out of /workspace the agent is trying to exfiltrate
    // something it shouldn't touch. Block with 400.
    let canonical = abs_path.canonicalize().unwrap_or(abs_path.clone());
    if !canonical.starts_with(WORKSPACE_ROOT) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ShareResponse {
                ok: false,
                share_id: String::new(),
                share_type: String::new(),
                title: String::new(),
                files: vec![],
                total_size: 0,
                entry_point: None,
                error: Some("Path must be within /workspace".into()),
            }),
        ));
    }

    let collected = collect_files(&abs_path, &workspace).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ShareResponse {
                ok: false,
                share_id: String::new(),
                share_type: String::new(),
                title: String::new(),
                files: vec![],
                total_size: 0,
                entry_point: None,
                error: Some(e),
            }),
        )
    })?;

    if collected.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ShareResponse {
                ok: false,
                share_id: String::new(),
                share_type: String::new(),
                title: String::new(),
                files: vec![],
                total_size: 0,
                entry_point: None,
                error: Some("No files found at path".into()),
            }),
        ));
    }

    let is_dir = abs_path.is_dir();
    let file_entries: Vec<ShareFileEntry> =
        collected.iter().map(|(_, _, e)| e.clone()).collect();

    let (share_type, entry_point) = detect_share_type(&file_entries, is_dir);
    let total_size: u64 = file_entries.iter().map(|f| f.size).sum();
    let share_id = uuid::Uuid::new_v4().to_string();
    let title = req.title.unwrap_or_else(|| {
        abs_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    // Durable storage dispatch: GCS in prod, api service in local dev.
    // The api path is also the only option without cloud creds.
    let gcs_bucket = std::env::var("GCS_ARTIFACTS_BUCKET").unwrap_or_default();
    let upload_ok = if !gcs_bucket.is_empty() {
        upload_to_gcs(&gcs_bucket, &state.session_id, &share_id, &collected).await
    } else {
        upload_to_api(&state, &share_id, &collected).await
    };

    if !upload_ok {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ShareResponse {
                ok: false,
                share_id,
                share_type,
                title,
                files: file_entries,
                total_size,
                entry_point,
                error: Some("Failed to upload share files".into()),
            }),
        ));
    }

    let payload = serde_json::json!({
        "share_id": share_id,
        "share_type": share_type,
        "title": title,
        "path": req.path,
        "files": file_entries.iter().map(|f| serde_json::json!({
            "path": f.path,
            "size": f.size,
            "content_type": f.content_type,
        })).collect::<Vec<_>>(),
        "total_size": total_size,
        "entry_point": entry_point,
    });

    crate::nats_bridge::publish_event(&state, "agent.share", payload).await;

    tracing::info!(
        "share: {} ({}) — {} files, {} bytes",
        title,
        share_type,
        file_entries.len(),
        total_size
    );

    Ok(Json(ShareResponse {
        ok: true,
        share_id,
        share_type,
        title,
        files: file_entries,
        total_size,
        entry_point,
        error: None,
    }))
}

/// Upload every file to a GCS bucket under
/// `sessions/{session_id}/shares/{share_id}/{rel_path}`, using an
/// access token minted from the pod's service account via the GCE
/// metadata server.
async fn upload_to_gcs(
    bucket: &str,
    session_id: &str,
    share_id: &str,
    files: &[(String, Vec<u8>, ShareFileEntry)],
) -> bool {
    let token = match get_gce_token().await {
        Some(t) => t,
        None => {
            tracing::error!("share: failed to get GCE access token");
            return false;
        }
    };

    let client = reqwest::Client::new();
    for (rel_path, content, entry) in files {
        let object_name = format!("sessions/{}/shares/{}/{}", session_id, share_id, rel_path);
        let url = format!(
            "https://storage.googleapis.com/upload/storage/v1/b/{}/o?uploadType=media&name={}",
            bucket,
            urlencoding::encode(&object_name)
        );

        match client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", &entry.content_type)
            .body(content.clone())
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {}
            Ok(resp) => {
                tracing::error!(
                    "share: GCS upload failed for {}: {}",
                    rel_path,
                    resp.status()
                );
                return false;
            }
            Err(e) => {
                tracing::error!("share: GCS upload error for {}: {}", rel_path, e);
                return false;
            }
        }
    }
    true
}

/// Upload every file to the api service as base64-encoded JSON. This
/// is the local-dev path (no GCS bucket set); the api writes the files
/// to its share directory and serves them back on GET requests.
async fn upload_to_api(
    state: &Arc<AppState>,
    share_id: &str,
    files: &[(String, Vec<u8>, ShareFileEntry)],
) -> bool {
    let url = format!(
        "{}/api/workspaces/{}/sessions/{}/shares",
        state.api_url, state.workspace_slug, state.session_id
    );

    let files_payload: Vec<serde_json::Value> = files
        .iter()
        .map(|(rel_path, content, _)| {
            serde_json::json!({
                "path": rel_path,
                "content": base64_encode(content),
            })
        })
        .collect();

    let client = reqwest::Client::new();
    let mut req = client.post(&url).json(&serde_json::json!({
        "share_id": share_id,
        "files": files_payload,
    }));
    if !state.api_internal_token.is_empty() {
        req = req.header("X-Internal-Token", &state.api_internal_token);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => true,
        Ok(resp) => {
            tracing::warn!("share: api upload rejected ({})", resp.status());
            false
        }
        Err(e) => {
            tracing::warn!("share: api upload failed: {}", e);
            false
        }
    }
}

/// Fetch a short-lived access token from the GCE metadata server. Only
/// works on a GKE/GCE node whose service account has GCS write access.
async fn get_gce_token() -> Option<String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token")
        .header("Metadata-Flavor", "Google")
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = resp.json().await.ok()?;
    body["access_token"].as_str().map(|s| s.to_string())
}

/// Hand-rolled base64 encoder. We don't pull in a crate for this — the
/// only caller is the api upload path and the api side decodes with
/// stock Node APIs.
fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[(triple >> 18 & 0x3F) as usize] as char);
        result.push(CHARS[(triple >> 12 & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[(triple >> 6 & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str) -> ShareFileEntry {
        ShareFileEntry {
            path: path.into(),
            size: 0,
            content_type: guess_content_type(path),
        }
    }

    #[test]
    fn detects_single_html_as_site_with_itself_as_entry_point() {
        let files = vec![entry("report.html")];
        let (kind, entry_point) = detect_share_type(&files, false);
        assert_eq!(kind, "site");
        assert_eq!(entry_point.as_deref(), Some("report.html"));
    }

    #[test]
    fn detects_htm_extension_as_site() {
        let files = vec![entry("page.htm")];
        let (kind, entry_point) = detect_share_type(&files, false);
        assert_eq!(kind, "site");
        assert_eq!(entry_point.as_deref(), Some("page.htm"));
    }

    #[test]
    fn detects_directory_with_index_html_as_site() {
        let files = vec![entry("index.html"), entry("style.css"), entry("app.js")];
        let (kind, entry_point) = detect_share_type(&files, true);
        assert_eq!(kind, "site");
        assert_eq!(entry_point.as_deref(), Some("index.html"));
    }

    #[test]
    fn detects_directory_without_index_as_generic_file() {
        let files = vec![entry("report.pdf"), entry("chart.png")];
        let (kind, entry_point) = detect_share_type(&files, true);
        assert_eq!(kind, "file");
        assert_eq!(entry_point, None);
    }

    #[test]
    fn detects_raster_image_types() {
        for ext in &["png", "jpg", "jpeg", "gif", "webp"] {
            let files = vec![entry(&format!("pic.{}", ext))];
            let (kind, _) = detect_share_type(&files, false);
            assert_eq!(kind, "image", "{} should be image", ext);
        }
    }

    #[test]
    fn detects_svg_as_its_own_type() {
        let files = vec![entry("chart.svg")];
        let (kind, _) = detect_share_type(&files, false);
        assert_eq!(kind, "svg");
    }

    #[test]
    fn detects_csv_type() {
        let files = vec![entry("data.csv")];
        let (kind, _) = detect_share_type(&files, false);
        assert_eq!(kind, "csv");
    }

    #[test]
    fn detects_json_and_jsonl_both_as_json() {
        let (kind_json, _) = detect_share_type(&vec![entry("data.json")], false);
        let (kind_jsonl, _) = detect_share_type(&vec![entry("events.jsonl")], false);
        assert_eq!(kind_json, "json");
        assert_eq!(kind_jsonl, "json");
    }

    #[test]
    fn detects_archive_types() {
        for ext in &["zip", "tar", "gz", "tgz"] {
            let files = vec![entry(&format!("bundle.{}", ext))];
            let (kind, _) = detect_share_type(&files, false);
            assert_eq!(kind, "archive", "{} should be archive", ext);
        }
    }

    #[test]
    fn detects_markdown_as_document() {
        let files = vec![entry("README.md")];
        let (kind, _) = detect_share_type(&files, false);
        assert_eq!(kind, "document");
    }

    #[test]
    fn detects_source_code_by_extension() {
        for ext in &[
            "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "rb", "sql", "sh", "yaml", "yml",
            "toml", "css",
        ] {
            let files = vec![entry(&format!("file.{}", ext))];
            let (kind, _) = detect_share_type(&files, false);
            assert_eq!(kind, "code", "{} should be code", ext);
        }
    }

    #[test]
    fn unknown_extension_falls_back_to_generic_file() {
        let files = vec![entry("data.xyz")];
        let (kind, _) = detect_share_type(&files, false);
        assert_eq!(kind, "file");
    }

    #[test]
    fn file_without_extension_falls_back_to_generic_file() {
        let files = vec![entry("README")];
        let (kind, _) = detect_share_type(&files, false);
        assert_eq!(kind, "file");
    }

    #[test]
    fn extension_matching_is_case_insensitive() {
        let files = vec![entry("report.HTML")];
        let (kind, _) = detect_share_type(&files, false);
        assert_eq!(kind, "site");
    }

    #[test]
    fn content_type_for_html_variants() {
        assert_eq!(guess_content_type("index.html"), "text/html");
        assert_eq!(guess_content_type("page.htm"), "text/html");
    }

    #[test]
    fn content_type_for_images() {
        assert_eq!(guess_content_type("pic.png"), "image/png");
        assert_eq!(guess_content_type("photo.jpg"), "image/jpeg");
        assert_eq!(guess_content_type("photo.jpeg"), "image/jpeg");
        assert_eq!(guess_content_type("icon.svg"), "image/svg+xml");
    }

    #[test]
    fn content_type_for_data_formats() {
        assert_eq!(guess_content_type("data.json"), "application/json");
        assert_eq!(guess_content_type("log.jsonl"), "application/jsonl");
        assert_eq!(guess_content_type("sheet.csv"), "text/csv");
    }

    #[test]
    fn content_type_for_code() {
        assert_eq!(guess_content_type("main.ts"), "text/typescript");
        assert_eq!(guess_content_type("comp.tsx"), "text/typescript");
        assert_eq!(guess_content_type("script.py"), "text/x-python");
        assert_eq!(guess_content_type("lib.rs"), "text/x-rust");
    }

    #[test]
    fn content_type_fallback_for_unknown_or_missing_extension() {
        assert_eq!(
            guess_content_type("mystery.xyz"),
            "application/octet-stream"
        );
        assert_eq!(
            guess_content_type("no_extension"),
            "application/octet-stream"
        );
    }

    #[test]
    fn content_type_matching_is_case_insensitive() {
        assert_eq!(guess_content_type("REPORT.HTML"), "text/html");
        assert_eq!(guess_content_type("Data.JSON"), "application/json");
    }

    #[test]
    fn base64_encode_empty_input() {
        assert_eq!(base64_encode(b""), "");
    }

    #[test]
    fn base64_encode_one_two_three_byte_inputs() {
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
    }

    #[test]
    fn base64_encode_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_encode_binary_data() {
        assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79");
    }

    #[test]
    fn collects_single_file_from_temp_dir() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join(format!("x1-share-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let file_path = tmp.join("hello.txt");
        std::fs::File::create(&file_path)
            .unwrap()
            .write_all(b"hello world")
            .unwrap();

        let collected = collect_files(&file_path, &tmp).unwrap();
        assert_eq!(collected.len(), 1);
        let (rel, content, entry) = &collected[0];
        assert_eq!(rel, "hello.txt");
        assert_eq!(content, b"hello world");
        assert_eq!(entry.size, 11);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn collects_directory_recursively() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join(format!("x1-share-dir-{}", uuid::Uuid::new_v4()));
        let sub = tmp.join("sub");
        std::fs::create_dir_all(&sub).unwrap();

        std::fs::File::create(tmp.join("index.html"))
            .unwrap()
            .write_all(b"<html></html>")
            .unwrap();
        std::fs::File::create(sub.join("data.json"))
            .unwrap()
            .write_all(b"{}")
            .unwrap();

        let collected = collect_files(&tmp, &tmp).unwrap();
        assert_eq!(collected.len(), 2);
        let paths: Vec<&str> = collected.iter().map(|(p, _, _)| p.as_str()).collect();
        assert!(paths.iter().any(|p| *p == "index.html"));
        assert!(paths.iter().any(|p| p.contains("data.json")));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn collect_files_skips_hidden_directories() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join(format!("x1-share-hidden-{}", uuid::Uuid::new_v4()));
        let hidden = tmp.join(".git");
        std::fs::create_dir_all(&hidden).unwrap();

        std::fs::File::create(tmp.join("visible.txt"))
            .unwrap()
            .write_all(b"ok")
            .unwrap();
        std::fs::File::create(hidden.join("secret"))
            .unwrap()
            .write_all(b"no")
            .unwrap();

        let collected = collect_files(&tmp, &tmp).unwrap();
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].0, "visible.txt");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn collect_files_skips_node_modules() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join(format!("x1-share-nm-{}", uuid::Uuid::new_v4()));
        let nm = tmp.join("node_modules");
        std::fs::create_dir_all(&nm).unwrap();

        std::fs::File::create(tmp.join("package.json"))
            .unwrap()
            .write_all(b"{}")
            .unwrap();
        std::fs::File::create(nm.join("installed.js"))
            .unwrap()
            .write_all(b"noise")
            .unwrap();

        let collected = collect_files(&tmp, &tmp).unwrap();
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].0, "package.json");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn collect_files_errors_for_missing_path() {
        let bogus = std::path::PathBuf::from("/nonexistent/path/12345");
        assert!(collect_files(&bogus, &bogus).is_err());
    }
}
