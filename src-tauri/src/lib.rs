use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Prevents a console window from flashing when spawning PowerShell subprocesses.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
use tauri::menu::PredefinedMenuItem;

// Prevents two concurrent update flows (startup check + manual "Check for Updates" click).
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
// Latest available version tag found by background check, shown non-intrusively in the UI.
static AVAILABLE_UPDATE: Mutex<Option<String>> = Mutex::new(None);

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

/// Returns the latest available version tag found by the background update check,
/// or null if no update is available. Called from the renderer to show the update badge.
#[tauri::command]
fn get_update_version() -> Option<String> {
    AVAILABLE_UPDATE.lock().ok().and_then(|g| g.clone())
}

/// Triggers the download + install flow. Re-checks GitHub at click time to always
/// get the absolute latest release (not the cached badge version).
/// Called from the renderer when the user clicks the update badge.
#[tauri::command]
fn install_update(app: AppHandle) {
    if !UPDATE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        let current_version = app.package_info().version.to_string();
        thread::spawn(move || {
            match check_for_update(&current_version) {
                Some(latest_tag) => {
                    if let Ok(mut guard) = AVAILABLE_UPDATE.lock() {
                        *guard = Some(latest_tag.clone());
                    }
                    handle_update_available(&app, &latest_tag);
                }
                None => {
                    // Already on latest — clear badge
                    if let Ok(mut guard) = AVAILABLE_UPDATE.lock() {
                        *guard = None;
                    }
                }
            }
            UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
        });
    }
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

#[derive(Deserialize)]
struct ScheduleResponse {
    #[serde(rename = "nextRunAt")]
    next_run_at: Option<u64>, // epoch ms, null while running or not configured
}

#[derive(Deserialize)]
struct UpdateCheckResponse {
    pending: bool,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
}

/// Check GitHub releases API for a newer version.
/// Returns Some(tag_name) like "v0.4.0" if an update is available, None otherwise.
fn check_for_update(current_version: &str) -> Option<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let release: GitHubRelease = client
        .get("https://api.github.com/repos/Bishi/auto-scraper-agent/releases/latest")
        .header("User-Agent", "auto-scraper-agent")
        .send()
        .ok()?
        .json()
        .ok()?;
    let latest = release.tag_name.trim_start_matches('v');
    if latest != current_version {
        Some(release.tag_name)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Update dialogs — PowerShell MessageBox (no extra dependencies, Windows-only)
// ---------------------------------------------------------------------------

/// DPI-awareness bootstrap prepended to every dialog script.
///
/// Each dialog runs in a fresh powershell.exe process which is not DPI-aware
/// by default, causing blurry rendering on high-DPI / scaled displays.
/// Calling SetProcessDPIAware() before showing any WinForms control fixes it.
const DPI_PREFIX: &str = concat!(
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] ",
    "public static extern bool SetProcessDPIAware();' ",
    "-Name DpiHelper -Namespace Win32 -PassThru | Out-Null; ",
    "[Win32.DpiHelper]::SetProcessDPIAware() | Out-Null; ",
    "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; ",
);

/// Show a Yes/No dialog. Returns true if the user clicked Yes.
fn dialog_yes_no(title: &str, message: &str) -> bool {
    // Escape single quotes for PowerShell string literals
    let msg   = message.replace('\'', "''");
    let title = title.replace('\'', "''");
    let script = format!(
        "{DPI_PREFIX}[System.Windows.Forms.MessageBox]::Show('{msg}', '{title}', \
         'YesNo', 'Question') -eq 'Yes'"
    );
    std::process::Command::new("powershell")
        .args(["-WindowStyle", "Hidden", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "True")
        .unwrap_or(false)
}

/// Show an informational OK dialog.
fn dialog_ok(title: &str, message: &str) {
    let msg   = message.replace('\'', "''");
    let title = title.replace('\'', "''");
    let script = format!(
        "{DPI_PREFIX}[System.Windows.Forms.MessageBox]::Show('{msg}', '{title}', \
         'OK', 'Information') | Out-Null"
    );
    let _ = std::process::Command::new("powershell")
        .args(["-WindowStyle", "Hidden", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

// ---------------------------------------------------------------------------
// Installer download
// ---------------------------------------------------------------------------

fn installer_download_url(tag: &str) -> String {
    let version = tag.trim_start_matches('v');
    format!(
        "https://github.com/Bishi/auto-scraper-agent/releases/download/{tag}/\
         Auto-Scraper.Agent_{version}_x64-setup.exe"
    )
}

fn set_tray_tooltip(app: &AppHandle, msg: &str) {
    if let Some(tray) = app.tray_by_id("main") {
        // Toggling to a zero-width space before setting the real text forces
        // Windows to re-render the tooltip popup if it's currently displayed.
        let _ = tray.set_tooltip(Some("\u{200B}"));
        let _ = tray.set_tooltip(Some(msg));
    }
}

/// Stream the installer for `tag` to %TEMP%, updating the tray tooltip with
/// download progress.  Returns the path to the downloaded file.
///
/// Uses a GET (not HEAD) so redirects are followed before checking the status
/// and content-length — GitHub release assets redirect to a CDN and HEAD often
/// returns 0 for content-length on the redirect response.
///
/// Fails immediately with a clear error if the server returns a non-2xx status
/// (e.g. 404 when the CI hasn't finished uploading the asset yet), preventing
/// a GitHub HTML error page from being written to disk as a fake installer.
fn download_installer(tag: &str, app: &AppHandle) -> Result<PathBuf, String> {
    let version = tag.trim_start_matches('v');
    let url     = installer_download_url(tag);
    let dest    = std::env::temp_dir()
        .join(format!("auto-scraper-agent-{version}-setup.exe"));

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300)) // 5 min — large file
        .build()
        .map_err(|e| e.to_string())?;

    // Open the connection first so we can validate the status before touching disk.
    let mut response = client.get(&url).send().map_err(|e| e.to_string())?;

    // Fail fast — a non-success status means the release asset doesn't exist yet.
    // Without this check, a 404 HTML page gets saved as the installer and Windows
    // rejects it as an "Unsupported 16-bit Application".
    if !response.status().is_success() {
        return Err(format!(
            "HTTP {} — release asset not found for v{version}.\n\
             The installer may still be building. Try again in a few minutes,\n\
             or download manually from github.com/Bishi/auto-scraper-agent/releases.",
            response.status().as_u16()
        ));
    }

    // content_length() from the CDN response (after redirects) is reliable here.
    let total_bytes: u64 = response.content_length().unwrap_or(0);

    // Skip download if the file is already fully present (sizes must match).
    if total_bytes > 0 {
        if let Ok(meta) = std::fs::metadata(&dest) {
            if meta.len() == total_bytes {
                eprintln!("[agent] Installer already downloaded: {}", dest.display());
                return Ok(dest);
            }
        }
    }

    // Remove any stale / partial file from a previous failed attempt.
    let _ = std::fs::remove_file(&dest);

    eprintln!("[agent] Downloading installer from {url}");
    set_tray_tooltip(app, "Auto-Scraper — Starting download…");

    let mut file = File::create(&dest).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut buf = vec![0u8; 65_536]; // 64 KB chunks

    loop {
        let n = response.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;

        let tooltip = if total_bytes > 0 {
            format!(
                "Auto-Scraper — Downloading update: {} / {} MB ({}%)",
                downloaded  / 1_048_576,
                total_bytes / 1_048_576,
                downloaded * 100 / total_bytes,
            )
        } else {
            format!("Auto-Scraper — Downloading update: {} MB", downloaded / 1_048_576)
        };
        set_tray_tooltip(app, &tooltip);
    }

    eprintln!("[agent] Download complete: {} bytes", downloaded);
    Ok(dest)
}

// ---------------------------------------------------------------------------
// Full update flow: dialog → download → install dialog → launch → exit
// ---------------------------------------------------------------------------

/// Called whenever we know `latest_tag` is newer than the running version.
/// Guards against concurrent calls with UPDATE_IN_PROGRESS.
fn handle_update_available(app: &AppHandle, latest_tag: &str) {
    // Only one update flow at a time
    if UPDATE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return;
    }

    let version = latest_tag.trim_start_matches('v');
    let current = app.package_info().version.to_string();

    let want_download = dialog_yes_no(
        "Update Available",
        &format!(
            "Auto-Scraper Agent v{version} is available  (you have v{current}).\n\n\
             Download and install now?  (~150 MB)\n\n\
             Progress will be shown in the tray tooltip."
        ),
    );

    if !want_download {
        UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
        set_tray_tooltip(app, &format!("Auto-Scraper Agent — Update available: v{version}"));
        return;
    }

    match download_installer(latest_tag, app) {
        Ok(installer_path) => {
            set_tray_tooltip(app, "Auto-Scraper Agent — Update ready");

            let want_install = dialog_yes_no(
                "Update Ready",
                &format!(
                    "v{version} has been downloaded.\n\n\
                     Install now?  The agent will restart automatically."
                ),
            );

            if want_install {
                eprintln!("[agent] Launching installer: {}", installer_path.display());
                // Use PowerShell Start-Process (→ ShellExecuteW) instead of
                // Command::new (→ CreateProcess) so Windows handles UAC elevation
                // for the installer's requireAdministrator manifest entry.
                let escaped = installer_path.to_string_lossy().replace('\'', "''");
                let _ = std::process::Command::new("powershell")
                    .args(["-WindowStyle", "Hidden", "-NonInteractive", "-Command",
                           &format!("Start-Process -FilePath '{escaped}'")])
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn();
                app.exit(0);
            } else {
                // Keep the file for next time; reset the flag so the user can
                // trigger installation again from the tray menu.
                UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
                set_tray_tooltip(app, "Auto-Scraper Agent — Update ready (not yet installed)");
            }
        }
        Err(e) => {
            eprintln!("[agent] Download failed: {e}");
            UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
            set_tray_tooltip(app, "Auto-Scraper Agent");
            dialog_ok("Download Failed", &format!("Could not download the update:\n\n{e}"));
        }
    }
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
    .inner_size(680.0, 620.0)
    .resizable(true)
    .center()
    .build();
}

// ---------------------------------------------------------------------------
// Tray menu
// ---------------------------------------------------------------------------

fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let run_now       = MenuItem::with_id(app, "run_now",       "Run Now",             true, None::<&str>)?;
    let open          = MenuItem::with_id(app, "open",          "Open Dashboard",      true, None::<&str>)?;
    let setup         = MenuItem::with_id(app, "setup",         "Settings / Setup",    true, None::<&str>)?;
    let check_updates = MenuItem::with_id(app, "check_updates", "Check for Updates",   true, None::<&str>)?;
    let sep           = PredefinedMenuItem::separator(app)?;
    let quit          = MenuItem::with_id(app, "quit",          "Quit",                true, None::<&str>)?;
    Menu::with_items(app, &[&run_now, &open, &setup, &sep, &check_updates, &quit])
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
        "check_updates" => {
            let app_clone = app.clone();
            let current_version = app.package_info().version.to_string();
            thread::spawn(move || {
                match check_for_update(&current_version) {
                    Some(latest_tag) => {
                        if let Ok(mut guard) = AVAILABLE_UPDATE.lock() {
                            *guard = Some(latest_tag.clone());
                        }
                        handle_update_available(&app_clone, &latest_tag);
                    }
                    None => {
                        eprintln!("[agent] App is up to date");
                        if let Ok(mut guard) = AVAILABLE_UPDATE.lock() {
                            *guard = None;
                        }
                        dialog_ok(
                            "Up to Date",
                            &format!("Auto-Scraper Agent v{current_version} is the latest version."),
                        );
                    }
                }
            });
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
        .invoke_handler(tauri::generate_handler![save_config, get_update_version, install_update])
        .setup(|app| {
            // Clean up any leftover installer files from a previous auto-update.
            // Done in a background thread with a delay: NSIS may still be alive
            // (showing the Finish page) when the new agent starts, keeping the
            // file locked. 30 s is enough for the user to click Finish.
            thread::spawn(|| {
                thread::sleep(Duration::from_secs(30));
                let temp = std::env::temp_dir();
                if let Ok(entries) = std::fs::read_dir(&temp) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        if name.starts_with("auto-scraper-agent-") && name.ends_with("-setup.exe") {
                            if std::fs::remove_file(entry.path()).is_ok() {
                                eprintln!("[agent] Cleaned up old installer: {}", entry.path().display());
                            }
                        }
                    }
                }
            });

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

            // Background thread: silently check for updates on startup (after 15 s delay)
            // then every 6 h. Stores the latest tag in AVAILABLE_UPDATE so the renderer
            // can show a non-intrusive badge. No dialog is shown automatically.
            let current_version = app.package_info().version.to_string();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(15));
                loop {
                    if let Some(latest_tag) = check_for_update(&current_version) {
                        eprintln!("[agent] Update available: {}", latest_tag);
                        if let Ok(mut guard) = AVAILABLE_UPDATE.lock() {
                            *guard = Some(latest_tag);
                        }
                    } else if let Ok(mut guard) = AVAILABLE_UPDATE.lock() {
                        *guard = None; // clear stale entry if somehow rolled back
                    }
                    thread::sleep(Duration::from_secs(6 * 60 * 60));
                }
            });

            // Background thread: poll /schedule every 30 s and update the tray tooltip
            // so the user can see the next scrape time by hovering the tray icon.
            let tooltip_handle = app.handle().clone();
            thread::spawn(move || {
                let client = match reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(2))
                    .build()
                {
                    Ok(c) => c,
                    Err(_) => return,
                };
                loop {
                    thread::sleep(Duration::from_secs(30));

                    // Check if the server sent a check_update command to this agent.
                    let update_pending = client
                        .get("http://127.0.0.1:9001/update/check")
                        .send()
                        .ok()
                        .and_then(|r| r.json::<UpdateCheckResponse>().ok())
                        .map(|r| r.pending)
                        .unwrap_or(false);
                    if update_pending && !UPDATE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
                        let app_clone = tooltip_handle.clone();
                        let current_version = tooltip_handle.package_info().version.to_string();
                        thread::spawn(move || {
                            match check_for_update(&current_version) {
                                Some(latest_tag) => handle_update_available(&app_clone, &latest_tag),
                                None => dialog_ok(
                                    "Up to Date",
                                    &format!("Auto-Scraper Agent v{current_version} is the latest version."),
                                ),
                            }
                            UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
                        });
                    }

                    let tooltip = client
                        .get("http://127.0.0.1:9001/schedule")
                        .send()
                        .ok()
                        .and_then(|r| r.json::<ScheduleResponse>().ok())
                        .map(|s| {
                            if let Some(next_ms) = s.next_run_at {
                                let now_ms = std::time::SystemTime::now()
                                    .duration_since(std::time::SystemTime::UNIX_EPOCH)
                                    .map(|d| d.as_millis() as u64)
                                    .unwrap_or(0);
                                let diff_min = next_ms.saturating_sub(now_ms) / 60_000;
                                format!("Auto-Scraper — next scrape in {} min", diff_min)
                            } else {
                                "Auto-Scraper — scraping now…".to_string()
                            }
                        })
                        .unwrap_or_else(|| "Auto-Scraper Agent".to_string());
                    if let Some(tray) = tooltip_handle.tray_by_id("main") {
                        let _ = tray.set_tooltip(Some(tooltip.as_str()));
                    }
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
