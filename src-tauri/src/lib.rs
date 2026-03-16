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
use tauri_plugin_shell::process::CommandEvent;
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Called from the setup window renderer when the user submits the config form.
/// apiKey is empty-string when the user wants to keep the previously saved key.
#[tauri::command]
fn save_config(
    _app: AppHandle,
    api_key: String,
    server_url: String,
) -> Result<(), String> {
    // Build body — omit apiKey entirely when empty so the sidecar reuses its
    // saved key (avoids forcing the user to re-enter it every time).
    let body = if api_key.is_empty() {
        serde_json::json!({ "serverUrl": server_url })
    } else {
        serde_json::json!({ "apiKey": api_key, "serverUrl": server_url })
    };

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    // Retry up to 3 times — sidecar may still be starting.
    let mut last_err = String::new();
    for attempt in 0..3u8 {
        if attempt > 0 {
            thread::sleep(Duration::from_secs(1));
        }
        match client.post("http://127.0.0.1:9001/config").json(&body).send() {
            Ok(resp) => {
                resp.error_for_status()
                    .map_err(|e| format!("Sidecar returned error: {e}"))?;
                // Window stays open — the renderer shows a success banner and
                // the user can switch to the Logs tab or close manually.
                return Ok(());
            }
            Err(e) => last_err = e.to_string(),
        }
    }

    Err(format!(
        "Could not reach the agent sidecar on port 9001 after 3 attempts.\n\
         Make sure the sidecar is running (in dev mode: cd scraper-node && npm run dev).\n\n\
         Detail: {last_err}"
    ))
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

fn open_setup_window<R: Runtime>(app: &AppHandle<R>, tab: Option<&str>) {
    if let Some(win) = app.get_webview_window("setup") {
        // Window already exists — just bring it to front.
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let url_path = match tab {
        Some(t) => format!("index.html?tab={}", t),
        None    => "index.html".to_string(),
    };
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "setup",
        tauri::WebviewUrl::App(url_path.into()),
    )
    .title("Auto-Scraper Agent")
    .inner_size(540.0, 500.0)
    .resizable(true)
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
            // Fire the scrape in the background — don't block the menu event handler.
            let _ = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .map(|c| c.post("http://127.0.0.1:9001/scrape/now").send());
            // Open (or focus) the agent window on the Logs tab so the user can
            // see live progress without having to open it manually.
            open_setup_window(app, Some("logs"));
        }
        "open" => {
            let url = sidecar_server_url();
            let _ = app.opener().open_url(&url, None::<String>);
        }
        "setup" => {
            open_setup_window(app, None);
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

            let (rx, child) = sidecar_cmd
                .spawn()
                .expect("failed to spawn scraper-node sidecar");

            // Prevent any kill-on-drop behaviour. The sidecar must live for
            // the entire app lifetime; the "Quit" menu item shuts it down via
            // POST /stop before calling app.exit(0).
            std::mem::forget(child);

            // Watchdog: drain the event channel (keeps the OS pipe flowing so
            // sidecar stdout never blocks) and restart the sidecar automatically
            // if it crashes. On each restart the sidecar re-reads its saved
            // config from disk, so the scheduler resumes without user action.
            let watchdog_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut rx = rx;
                loop {
                    // Drain events until the sidecar exits.
                    while let Some(event) = rx.recv().await {
                        if let CommandEvent::Terminated(payload) = event {
                            eprintln!(
                                "[agent] Sidecar exited (code {:?}), restarting in 3 s…",
                                payload.code
                            );
                            break;
                        }
                    }
                    // Brief pause to avoid a tight crash loop.
                    tauri::async_runtime::spawn_blocking(|| {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                    })
                    .await
                    .ok();
                    // Re-spawn the sidecar.
                    match watchdog_handle
                        .shell()
                        .sidecar("scraper-node")
                        .and_then(|c| c.spawn())
                    {
                        Ok((new_rx, new_child)) => {
                            std::mem::forget(new_child);
                            rx = new_rx;
                            eprintln!("[agent] Sidecar restarted.");
                        }
                        Err(e) => {
                            eprintln!("[agent] Could not restart sidecar: {e}");
                            break;
                        }
                    }
                }
            });

            // Build tray icon — created entirely in Rust so there is only one icon.
            // (No trayIcon section in tauri.conf.json.)
            let menu = build_tray_menu(app.handle())?;
            let app_handle_tray = app.handle().clone();

            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .menu_on_left_click(false)
                .tooltip("Auto-Scraper Agent");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(move |app, event| handle_menu_event(app, event))
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        // Left-click always opens/focuses the window. When no API
                        // key is saved yet, open on Settings; otherwise open on Logs.
                        let tab = if sidecar_has_api_key() { Some("logs") } else { None };
                        open_setup_window(&app_handle_tray, tab);
                    }
                })
                .build(app)?;

            // Wait for sidecar in background, then open the window.
            // Not configured yet → Settings tab so the user can enter credentials.
            // Already configured  → Logs tab so they can see activity straight away.
            let handle = app.handle().clone();
            thread::spawn(move || {
                if wait_for_sidecar() {
                    let tab = if sidecar_has_api_key() { Some("logs") } else { None };
                    open_setup_window(&handle, tab);
                } else {
                    eprintln!("[agent] Sidecar did not start within 10 seconds");
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Keep the process alive when all windows are closed so the tray
            // icon persists.
            // IMPORTANT: only prevent exit when triggered by a window close
            // (code is None). When the "Quit" menu item calls app.exit(0),
            // code is Some(0) — do NOT prevent it or Quit silently does nothing.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
