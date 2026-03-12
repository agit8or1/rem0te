mod launch;

use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

struct LaunchUrl(Mutex<Option<String>>);

#[tauri::command]
async fn launch_session(
    url: String,
    app: AppHandle,
) -> Result<launch::LaunchResult, String> {
    launch::handle_launch_url(&url, app).await
}

#[tauri::command]
fn get_launch_url(state: State<'_, LaunchUrl>) -> Option<String> {
    state.0.lock().ok()?.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .manage(LaunchUrl(Mutex::new(None)))
        .setup(|app| {
            // Register the deep-link scheme (desktop only)
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register("reboot-remote")?;
            }

            // If launched from CLI with a URL argument, store it
            let args: Vec<String> = std::env::args().collect();
            if let Some(url) = args.get(1).filter(|a| a.starts_with("reboot-remote://")) {
                if let Some(state) = app.try_state::<LaunchUrl>() {
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = Some(url.clone());
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![launch_session, get_launch_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
