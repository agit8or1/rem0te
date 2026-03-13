use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::AppHandle;
use url::Url;

#[derive(Debug, Serialize)]
pub struct LaunchResult {
    #[serde(rename = "rustdeskId")]
    pub rustdesk_id: String,
}

#[derive(Debug, Deserialize)]
struct ValidateResponse {
    success: bool,
    data: Option<ValidateData>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ValidateData {
    #[serde(rename = "targetRustdeskId")]
    target_rustdesk_id: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

/// Parse a `reboot-remote://launch#token=<jwt>&api=<url>` deep link,
/// validate the token with the API, spawn RustDesk, and return the peer ID.
/// Token is passed in the URL fragment so it is never sent to any server or
/// recorded in proxy / server access logs.
pub async fn handle_launch_url(
    url_str: &str,
    app: AppHandle,
) -> Result<LaunchResult, String> {
    let url = Url::parse(url_str).map_err(|e| format!("Invalid URL: {e}"))?;

    // Parse key=value pairs from the fragment (#token=...&api=...)
    let fragment = url.fragment().unwrap_or("");
    let params: std::collections::HashMap<String, String> =
        form_urlencoded::parse(fragment.as_bytes())
            .into_owned()
            .collect();

    let token = params
        .get("token")
        .cloned()
        .ok_or_else(|| "Missing token parameter".to_string())?;

    let api_base = params
        .get("api")
        .cloned()
        .unwrap_or_else(|| "http://localhost:3001".to_string());

    // Validate token with API
    let validate_url = format!("{}/api/v1/launcher/validate", api_base.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .get(&validate_url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Failed to reach API: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("API returned status {}", resp.status()));
    }

    let body: ValidateResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid API response: {e}"))?;

    if !body.success {
        return Err(body.message.unwrap_or_else(|| "Token validation failed".into()));
    }

    let data = body.data.ok_or_else(|| "No data in response".to_string())?;
    let rustdesk_id = data
        .target_rustdesk_id
        .ok_or_else(|| "No target RustDesk ID".to_string())?;

    // Spawn RustDesk
    spawn_rustdesk(&rustdesk_id, app.clone()).await?;

    // Post client_opened event if we have a session ID
    if let Some(session_id) = data.session_id {
        let event_url = format!(
            "{}/api/v1/sessions/{}/events",
            api_base.trim_end_matches('/'),
            session_id
        );
        let _ = client
            .post(&event_url)
            .bearer_auth(&token)
            .json(&serde_json::json!({ "event": "client_opened" }))
            .send()
            .await;
    }

    Ok(LaunchResult { rustdesk_id })
}

async fn spawn_rustdesk(peer_id: &str, _app: AppHandle) -> Result<(), String> {
    let candidates: &[&str] = &[
        "rustdesk",
        "/usr/bin/rustdesk",
        "/usr/local/bin/rustdesk",
        r"C:\Program Files\RustDesk\rustdesk.exe",
        r"C:\Program Files (x86)\RustDesk\rustdesk.exe",
        "/Applications/RustDesk.app/Contents/MacOS/RustDesk",
    ];

    let binary = candidates
        .iter()
        .find(|&&p| {
            if p.contains('/') || p.contains('\\') {
                Path::new(p).exists()
            } else {
                // For bare names, assume it's on PATH
                true
            }
        })
        .copied()
        .ok_or_else(|| "RustDesk binary not found".to_string())?;

    tokio::process::Command::new(binary)
        .arg("--connect")
        .arg(peer_id)
        .spawn()
        .map_err(|e| format!("Failed to spawn RustDesk: {e}"))?;

    Ok(())
}
