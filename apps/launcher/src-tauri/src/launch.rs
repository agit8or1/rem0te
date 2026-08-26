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
    /// Base64 `host=…,key=…,api=,relay=…` for `rustdesk --config`. Applied
    /// before connecting so the deep link works on a RustDesk that has never
    /// been pointed at this server. None when the platform has no relay host
    /// configured — then we connect with whatever the client already has.
    #[serde(rename = "rustdeskConfig")]
    rustdesk_config: Option<String>,
    // `sessionId` is also returned, but the launcher no longer needs it: the
    // server records the session event itself at validation time. Serde
    // ignores response fields we do not declare.
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
    spawn_rustdesk(&rustdesk_id, data.rustdesk_config.as_deref(), app.clone()).await?;

    // The `client_opened` event is recorded server-side by /launcher/validate.
    //
    // This used to POST it to /sessions/:id/events with the launcher token as
    // a bearer credential, which could never succeed: that route is behind
    // JwtAuthGuard and a launcher token is signed with LAUNCHER_TOKEN_SECRET,
    // not JWT_SECRET. Because the result was discarded, it failed silently on
    // every launch and sessions never left PENDING.

    Ok(LaunchResult { rustdesk_id })
}

/// Locate the RustDesk binary.
///
/// The bare name went first and matched unconditionally — the closure returned
/// `true` for anything without a path separator — so `find` never reached a
/// single one of the absolute paths below it. On a normal Windows install
/// RustDesk is not on PATH, so the spawn failed with "program not found" while
/// `C:\Program Files\RustDesk\rustdesk.exe` sat there untried. Real paths are
/// checked first now, and the bare name is the last resort it was meant to be.
fn find_rustdesk() -> &'static str {
    const ABSOLUTE: &[&str] = &[
        r"C:\Program Files\RustDesk\rustdesk.exe",
        r"C:\Program Files (x86)\RustDesk\rustdesk.exe",
        "/Applications/RustDesk.app/Contents/MacOS/RustDesk",
        "/usr/bin/rustdesk",
        "/usr/local/bin/rustdesk",
    ];

    ABSOLUTE
        .iter()
        .find(|p| Path::new(p).exists())
        .copied()
        // Nothing at a known location: fall back to PATH and let the spawn
        // report the failure if it is not there either.
        .unwrap_or("rustdesk")
}

async fn spawn_rustdesk(
    peer_id: &str,
    config: Option<&str>,
    _app: AppHandle,
) -> Result<(), String> {
    let binary = find_rustdesk();

    // Point RustDesk at this server before connecting. `--config` rewrites the
    // client's server settings and exits, so it has to complete before
    // `--connect` runs or the connection uses the old rendezvous server.
    //
    // A failure here is deliberately not fatal: a client that is already
    // configured correctly still connects fine, and refusing to launch would
    // turn a cosmetic problem into a broken Connect button.
    if let Some(cfg) = config {
        let apply = tokio::process::Command::new(binary)
            .arg("--config")
            .arg(cfg)
            .status();
        // Bounded: this runs on the path a technician is waiting on, and an
        // unbounded await on a third-party binary would turn a hung RustDesk
        // into a Connect button that never does anything at all.
        match tokio::time::timeout(std::time::Duration::from_secs(10), apply).await {
            Ok(Ok(status)) if !status.success() => {
                eprintln!("rustdesk --config exited with {status}; connecting anyway");
            }
            Ok(Err(e)) => {
                eprintln!("Could not apply RustDesk server config: {e}; connecting anyway");
            }
            Err(_) => eprintln!("rustdesk --config timed out; connecting anyway"),
            Ok(Ok(_)) => {}
        }
    }

    tokio::process::Command::new(binary)
        .arg("--connect")
        .arg(peer_id)
        .spawn()
        .map_err(|e| format!("Failed to spawn RustDesk: {e}"))?;

    Ok(())
}
