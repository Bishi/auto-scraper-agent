use std::thread;
use std::time::Duration;

use tauri::{
    AppHandle, Manager, Runtime,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    menu::{Menu, MenuEvent, MenuItem},
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::ShellExt;
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Called from the setup window renderer when the user submits the API key form.
#[tauri::command]
fn save_config(
    app: AppHandle,
    api_key: String,
    server_url: String,
) -> Result<(), String> {
    let body = serde_json::json!({ "apiKey": api_key, "serverUrl": server_url });
    reqwest::blocking::Client::new()
        .post("http://127.0.0.1:9001/config")
        .json(&body)
        .send()
        .map_err(|e| format!("Failed to contact sidecar: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Sidecar returned error: {e}"))?;

    if let Some(win) = app.get_webview_window("setup") {
        let _ = win.close();
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Wait up to ~10 s for the sidecar HTTP server to respond on :9001.
fn wait_for_sidecar() -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();

    for _ in 0..10 {
        if client.get("http://127.0.0.1:9001/health").send().is_ok() {
            return true;
        }
        thread::sleep(Duration::from_secs(1));
    }
    false
}

#[derive(Deserialize)]
struct HealthResponse {
    #[serde(rename = "hasApiKey")]
    has_api_key: bool,
}

fn sidecar_has_api_key() -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()
        .and_then(|c| {
            c.get("http://127.0.0.1:9001/health")
                .send()
                .ok()
                .and_then(|r| r.json::<HealthResponse>().ok())
        })
        .map(|h| h.has_api_key)
        .unwrap_or(false)
}

fn sidecar_server_url() -> String {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()
        .and_then(|c| {
            c.get("http://127.0.0.1:9001/config")
                .send()
                .ok()
                .and_then(|r| r.json::<serde_json::Value>().ok())
        })
        .and_then(|v| v["serverUrl"].as_str().map(String::from))
        .unwrap_or_else(|| "http://localhost:3000".to_string())
}

fn open_setup_window<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window("setup").is_some() {
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "setup",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Auto-Scraper Setup")
    .inner_size(480.0, 320.0)
    .resizable(false)
    .center()
    .build();
}

// ---------------------------------------------------------------------------
// Tray menu
// ---------------------------------------------------------------------------

fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let run_now = MenuItem::with_id(app, "run_now", "Run Now", true, None::<&str>)?;
    let open    = MenuItem::with_id(app, "open",    "Open Dashboard", true, None::<&str>)?;
    let setup   = MenuItem::with_id(app, "setup",   "Settings / Setup", true, None::<&str>)?;
    let quit    = MenuItem::with_id(app, "quit",    "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&run_now, &open, &setup, &quit])
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "run_now" => {
            let _ = reqwest::blocking::Client::new()
                .post("http://127.0.0.1:9001/scrape/now")
                .send();
        }
        "open" => {
            let url = sidecar_server_url();
            let _ = app.opener().open_url(&url, None::<String>);
        }
        "setup" => {
            open_setup_window(app);
        }
        "quit" => {
            let _ = reqwest::blocking::Client::new()
                .post("http://127.0.0.1:9001/stop")
                .send();
            thread::sleep(Duration::from_millis(600));
            app.exit(0);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![save_config])
        .setup(|app| {
            // Spawn the Node.js sidecar.
            let sidecar_cmd = app
                .shell()
                .sidecar("scraper-node")
                .expect("scraper-node sidecar not configured");

            let (_rx, _child) = sidecar_cmd
                .spawn()
                .expect("failed to spawn scraper-node sidecar");

            // Build tray icon.
            let menu = build_tray_menu(app.handle())?;
            let app_handle_tray = app.handle().clone();
            TrayIconBuilder::with_id("main")
                .menu(&menu)
                .on_menu_event(move |app, event| handle_menu_event(app, event))
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if !sidecar_has_api_key() {
                            open_setup_window(&app_handle_tray);
                        }
                    }
                })
                .build(app)?;

            // Wait for sidecar in background, then show setup if needed.
            let handle = app.handle().clone();
            thread::spawn(move || {
                if wait_for_sidecar() {
                    if !sidecar_has_api_key() {
                        open_setup_window(&handle);
                    }
                } else {
                    eprintln!("[agent] Sidecar did not start within 10 seconds");
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
