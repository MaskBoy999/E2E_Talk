//! E2E Chat — Website-in-a-Box.
//!
//! A thin native shell around the existing web app:
//! - On first launch there is no config, so a local setup window asks for the
//!   host's Tailscale address and tests it.
//! - Once configured, the main window loads that server's URL in the OS WebView.
//! - Native notifications, background-call keepalive and the tray are provided
//!   from here.
//!
//! Desktop-only pieces (tray, auto-start, close-to-tray) are `cfg(desktop)`;
//! the same crate builds for Android via `cargo tauri android build`.

mod config;

use std::sync::Mutex;
use std::time::Duration;

use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;
#[cfg(desktop)]
use tauri::WindowEvent;
#[cfg(desktop)]
use tauri_plugin_autostart::MacosLauncher;

use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use config::Config;

const MAIN_LABEL: &str = "main";
const SETUP_LABEL: &str = "setup";
const SETUP_PAGE: &str = "box-setup.html";

/// Shared state so window events and commands can read the live config.
#[derive(Default)]
pub struct AppState {
    pub cfg: Mutex<Config>,
}

// ── Windows ──────────────────────────────────────────────────────────────

/// Grant the *remote* app origin access to a small set of IPC commands.
///
/// The main window loads a user-chosen server, and Tauri refuses IPC to remote
/// origins by default. The host is only known at runtime, so the capability is
/// added dynamically (tauri's `dynamic-acl` feature) instead of in
/// `tauri.conf.json`. Re-adding for the same host is harmless.
fn grant_remote_ipc(app: &tauri::AppHandle, server_url: &str) {
    let Ok(url) = server_url.parse::<tauri::Url>() else {
        return;
    };
    let Some(host) = url.host_str().map(str::to_string) else {
        return;
    };

    // Core capability (events + native notifications). This one must hold:
    // if it fails, the web app silently falls back to browser notifications.
    let capability = CapabilityBuilder::new("remote-main")
        .remote(host.clone())
        .window(MAIN_LABEL)
        .permission("core:event:default")
        .permission("notification:default");
    if let Err(e) = app.add_capability(capability) {
        eprintln!("grant_remote_ipc({host}) failed: {e}");
    }

    // Android-only call keepalive, added as its own capability so that a
    // problem resolving it can never take notifications down with it. On
    // desktop the plugin has no commands, so JS never invokes this.
    let call_service = CapabilityBuilder::new("remote-call-service")
        .remote(host.clone())
        .window(MAIN_LABEL)
        .permission("call-service:default");
    if let Err(e) = app.add_capability(call_service) {
        eprintln!("grant_remote_ipc: call-service for {host} failed: {e}");
    }
}

/// Open (or focus/navigate) the main window at the configured server URL.
fn open_main(app: &tauri::AppHandle, server_url: &str) -> Result<(), String> {
    let parsed: tauri::Url = server_url
        .parse()
        .map_err(|e| format!("Invalid server address: {e}"))?;

    // Allow the remote page to raise native notifications / listen to events.
    grant_remote_ipc(app, server_url);

    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        // Address changed (tray → Change Server Address) — point it at the new host.
        let _ = w.navigate(parsed);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    let nav_app = app.clone();
    WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::External(parsed))
        .title("E2E Chat")
        .inner_size(1200.0, 780.0)
        .min_inner_size(720.0, 480.0)
        // Navigation allowlist: the window may only ever show the configured
        // host (or local blob:/data: URLs). Anything else — a link in a
        // message, a redirect to another site — is handed to the system
        // browser instead of being loaded inside the app.
        .on_navigation(move |url| {
            if !matches!(url.scheme(), "http" | "https") {
                return true; // local (blob:, data:, about:) — no network risk
            }
            // Read the live config so changing the server from the tray takes
            // effect immediately, without rebuilding the window.
            let allowed = nav_app
                .state::<AppState>()
                .cfg
                .lock()
                .ok()
                .and_then(|c| c.server_url.clone())
                .and_then(|s| s.parse::<tauri::Url>().ok())
                .map(|u| u.origin());
            if allowed.as_ref() == Some(&url.origin()) {
                return true;
            }
            let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open (or focus) the local setup window.
fn open_setup(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(SETUP_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, SETUP_LABEL, WebviewUrl::App(SETUP_PAGE.into()))
        .title("E2E Chat — Setup")
        .inner_size(560.0, 660.0)
        .resizable(false)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Commands ─────────────────────────────────────────────────────────────

#[tauri::command]
fn get_config(state: tauri::State<'_, AppState>) -> Config {
    state.cfg.lock().unwrap().clone()
}

#[derive(serde::Serialize)]
struct ConnResult {
    ok: bool,
    status: Option<u16>,
    detail: String,
}

/// Reachability probe for the setup screen. The server uses a self-signed
/// certificate (Tailscale), so certificate validation is accepted here; the
/// pinned-fingerprint trust flow is a later hardening step.
#[tauri::command]
async fn test_connection(url: String) -> Result<ConnResult, String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let target = url.trim_end_matches('/').to_string();
    match client.get(&target).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if resp.status().is_success() {
                Ok(ConnResult {
                    ok: true,
                    status: Some(status),
                    detail: "Connected — E2E Chat is reachable at this address.".into(),
                })
            } else {
                Ok(ConnResult {
                    ok: false,
                    status: Some(status),
                    detail: format!("The host answered with HTTP {status}."),
                })
            }
        }
        Err(e) => {
            let detail = if e.is_timeout() {
                "Timed out — is the host reachable and Tailscale connected?".to_string()
            } else if e.is_connect() {
                "Connection refused — is the server running on this port?".to_string()
            } else {
                format!("Could not connect: {e}")
            };
            Ok(ConnResult {
                ok: false,
                status: None,
                detail,
            })
        }
    }
}

/// Persist the chosen server + preferences, apply auto-start, then open the
/// app window and close the setup window.
#[tauri::command]
fn save_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    server_url: String,
    auto_start: bool,
    minimize_to_tray: bool,
) -> Result<(), String> {
    let server_url = server_url.trim().to_string();
    if server_url.is_empty() {
        return Err("Enter the host's Tailscale address first.".into());
    }
    // Validate before persisting so a typo can never brick the next launch.
    let _: tauri::Url = server_url
        .parse()
        .map_err(|_| "That doesn't look like a valid address (try https://100.x.x.x:3443)".to_string())?;

    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.server_url = Some(server_url.clone());
        cfg.auto_start = auto_start;
        cfg.minimize_to_tray = minimize_to_tray;
        config::save(&app, &cfg)?;
    }

    // Auto-start is desktop-only (and best-effort): never block launching on it.
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let autolaunch = app.autolaunch();
        let _ = if auto_start {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        };
    }

    open_main(&app, &server_url)?;
    if let Some(w) = app.get_webview_window(SETUP_LABEL) {
        let _ = w.close();
    }
    Ok(())
}

/// Re-open the setup window from the UI or the tray.
#[tauri::command]
fn show_setup(app: tauri::AppHandle) -> Result<(), String> {
    open_setup(&app)
}

/// Quit the app (used by the setup screen's Quit button).
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Native (OS-level) notification. The web app calls this when it's running
/// inside the box; on desktop it renders as a system banner, on Android as a
/// notification — in both cases far richer than the Web Notification API
/// (which Android WebView does not support at all).
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

// ── Desktop tray ─────────────────────────────────────────────────────────

#[cfg(desktop)]
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show E2E Chat", true, None::<&str>)?;
    let change = MenuItem::with_id(app, "change", "Change Server Address…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &change, &separator, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("E2E Chat")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window(MAIN_LABEL) {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                } else {
                    let url = app.state::<AppState>().cfg.lock().unwrap().server_url.clone();
                    match url {
                        Some(u) => {
                            let _ = open_main(app, &u);
                        }
                        None => {
                            let _ = open_setup(app);
                        }
                    }
                }
            }
            "change" => {
                let _ = open_setup(app);
            }
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// ── App ──────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // Android foreground-service keepalive for voice calls. Registered on
        // every platform so the ACL is identical; on desktop it does nothing.
        .plugin(tauri_plugin_call_service::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        None,
    ));

    let builder = builder
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            test_connection,
            save_config,
            show_setup,
            quit_app,
            notify
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Load persisted config into shared state.
            let cfg = config::load(&handle);
            *handle.state::<AppState>().cfg.lock().unwrap() = cfg.clone();

            // Route the first window: main app when configured, setup otherwise.
            match cfg.server_url.as_deref() {
                Some(url) => {
                    if let Err(e) = open_main(&handle, url) {
                        // A broken saved address must not strand the user: fall back.
                        eprintln!("open_main failed ({e}); opening setup");
                        let _ = open_setup(&handle);
                    }
                }
                None => {
                    let _ = open_setup(&handle);
                }
            }

            #[cfg(desktop)]
            build_tray(&handle)?;
            Ok(())
        });

    // Desktop: closing the main window hides it to the tray.
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let app = window.app_handle();
            let minimize = app
                .state::<AppState>()
                .cfg
                .lock()
                .map(|c| c.minimize_to_tray)
                .unwrap_or(true);
            if minimize && window.label() == MAIN_LABEL {
                api.prevent_close();
                let _ = window.hide();
            }
        }
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running E2E Chat");
}
