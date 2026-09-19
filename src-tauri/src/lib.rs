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

mod cert_probe;
mod config;

use std::sync::Mutex;

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

// ── Certificate pinning helpers ──────────────────────────────────────────

/// Run the blocking TOFU probe off the async worker pool.
async fn fingerprint(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || cert_probe::fingerprint_of(&url))
        .await
        .map_err(|e| e.to_string())?
}

/// Blocking variant for the sync call sites (startup, tray menu).
fn fingerprint_blocking(url: &str) -> Result<String, String> {
    let url = url.to_string();
    tauri::async_runtime::block_on(async move { fingerprint(url).await })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression guard for the "Save & Launch closes the app" bug.
    ///
    /// Mirrors save_config's TOFU re-check: it runs *on* tauri's async runtime
    /// (spawn), exactly like an async command does. The old code reached the
    /// probe through `fingerprint_blocking` → `async_runtime::block_on`, which
    /// panics a tokio worker with "cannot start a runtime from within a
    /// runtime"; with `panic = "abort"` in the release profile that aborted the
    /// process, so the app vanished with no error. This must stay await-based.
    #[test]
    fn async_pin_recheck_does_not_block_on_its_own_runtime() {
        let handle = tauri::async_runtime::spawn(async {
            // Port 1 refuses instantly, so the probe errors out fast and
            // check_pinned_cert treats an unprobeable host as acceptable.
            check_pinned_cert(
                "deadbeef",
                fingerprint("https://127.0.0.1:1".to_string()).await,
            )
        });
        let out = tauri::async_runtime::block_on(handle);
        assert!(
            out.expect("the recheck task panicked on its own runtime").is_ok(),
            "an unreachable host must not be treated as a certificate mismatch"
        );
    }
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
    // Capabilities match remote origins with URLPattern constructor strings,
    // which REQUIRE a scheme: `100.x.x.x:3443` panics the ACL resolver at
    // startup ("a relative input without a base URL is not valid"), taking the
    // whole app down before any window opens. An origin (scheme + host[:port],
    // default port already normalized away by the url crate) is both valid and
    // exactly what the page URL looks like, and pathname/search/hash are
    // auto-wildcarded from there.
    let origin = match url.port() {
        Some(port) => format!("{}://{}:{port}", url.scheme(), url.host_str().unwrap_or_default()),
        None => format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default()),
    };

    // Core capability (events + native notifications). This one must hold:
    // if it fails, the web app silently falls back to browser notifications.
    let capability = CapabilityBuilder::new("remote-main")
        .remote(origin.clone())
        .window(MAIN_LABEL)
        .permission("core:event:default")
        .permission("notification:default");
    if let Err(e) = app.add_capability(capability) {
        eprintln!("grant_remote_ipc({origin}) failed: {e}");
    }

    // Android-only call keepalive, added as its own capability so that a
    // problem resolving it can never take notifications down with it. On
    // desktop the plugin has no commands, so JS never invokes this.
    let call_service = CapabilityBuilder::new("remote-call-service")
        .remote(origin.clone())
        .window(MAIN_LABEL)
        .permission("call-service:default");
    if let Err(e) = app.add_capability(call_service) {
        eprintln!("grant_remote_ipc: call-service for {origin} failed: {e}");
    }
}

/// The certificate fingerprint the user trusted, if any.
fn pinned_cert(app: &tauri::AppHandle) -> Option<String> {
    app.state::<AppState>()
        .cfg
        .lock()
        .ok()
        .and_then(|c| c.pinned_cert_sha256.clone())
}

/// TOFU enforcement: refuse to open the app for a host whose certificate no
/// longer matches the pinned fingerprint. The user re-trusts (or aborts) from
/// the setup screen.
///
/// Only a *mismatch* is fatal. If the probe can't complete (host offline,
/// Tailscale down) we still treat it as acceptable: the page will show its own
/// connection error, and a temporary outage must never masquerade as a
/// certificate problem or force the user back through setup.
fn check_pinned_cert(pinned: &str, probed: Result<String, String>) -> Result<(), String> {
    match probed {
        Ok(actual) if actual != pinned => Err(cert_probe::mismatch_message()),
        Ok(_) => Ok(()),
        Err(e) => {
            eprintln!("certificate pin not checked: {e}");
            Ok(())
        }
    }
}

/// Open (or focus/navigate) the main window at the configured server URL.
///
/// Sync entry point for the main-thread call sites (startup, tray menu, second
/// instance). It probes the pin with `fingerprint_blocking`, which blocks the
/// calling thread — so it must never be reached from an async command. Those
/// await the probe themselves and call `open_main_window` directly.
fn open_main(app: &tauri::AppHandle, server_url: &str) -> Result<(), String> {
    if let Some(expected) = pinned_cert(app) {
        check_pinned_cert(&expected, fingerprint_blocking(server_url))?;
    }
    open_main_window(app, server_url)
}

/// Create (or focus/navigate) the main window. Does no certificate probing —
/// callers are responsible for checking the pin first.
fn open_main_window(app: &tauri::AppHandle, server_url: &str) -> Result<(), String> {
    let parsed: tauri::Url = server_url
        .parse()
        .map_err(|e| format!("Invalid server address: {e}"))?;

    // Allow the remote page to raise native notifications / listen to events.
    grant_remote_ipc(app, server_url);

    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        // Address changed (tray → Change Server Address) — point it at the new host.
        let _ = w.navigate(parsed);
        // `unminimize` is desktop-only in Tauri (it lives in a
        // `#[cfg(desktop)] impl`), and this function compiles for every
        // platform — so calling it unguarded failed the Android build with
        // E0599 "no method named unminimize". `show` is enough on mobile,
        // which has no minimised state.
        #[cfg(desktop)]
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
        // Tauri installs a *native* drop handler on the webview by default
        // (`dragDropEnabled`, default true). On Windows that handler swallows
        // HTML5 drag-and-drop inside the page, so every drag target in the app
        // silently stops firing — while the same page works in a browser,
        // which has no such handler. The UI uses HTML5 DnD exclusively and
        // never Tauri's `tauri://drag-*` events, so turn the native one off.
        .disable_drag_drop_handler()
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

/// Build the **main** window showing the local setup page.
///
/// Fallback for single-window platforms: Tauri can only open a second window
/// on Android 12L+ / iOS 13+, so on anything older `open_setup` cannot work at
/// all. Without this the app would launch to a blank screen with no way to
/// enter the server address.
fn open_main_at_setup(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App(SETUP_PAGE.into()))
        .title("E2E Chat — Setup")
        .inner_size(560.0, 660.0)
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

/// Reachability probe for the setup screen. TLS is verified via the TOFU
/// fingerprint pinned in the config (see `cert_probe.rs`) — a self-signed
/// Tailscale cert is accepted once the user has trusted it, and a *swapped*
/// cert is refused with a re-trust prompt in the UI.
#[tauri::command]
async fn test_connection(
    app: tauri::AppHandle,
    url: String,
) -> Result<ConnResult, String> {
    let state = app.state::<AppState>();
    let pinned = state
        .cfg
        .lock()
        .ok()
        .and_then(|c| c.pinned_cert_sha256.clone());
    let client = cert_probe::pinned_client(pinned.as_deref(), &url)?;

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

/// Fetch the host certificate's SHA-256 fingerprint (TOFU). The setup screen
/// calls this before saving so the user can pin what they saw at first trust.
#[tauri::command]
async fn probe_certificate(url: String) -> Result<String, String> {
    fingerprint(url).await
}

/// Persist the chosen server + preferences, apply auto-start, then open the
/// app window and close the setup window.
#[tauri::command]
async fn save_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    server_url: String,
    auto_start: bool,
    minimize_to_tray: bool,
    pin_cert: bool,
) -> Result<(), String> {
    let server_url = server_url.trim().to_string();
    if server_url.is_empty() {
        return Err("Enter the host's Tailscale address first.".into());
    }
    // Validate before persisting so a typo can never brick the next launch.
    let _: tauri::Url = server_url
        .parse()
        .map_err(|_| "That doesn't look like a valid address (try https://100.x.x.x:3443)".to_string())?;

    // TOFU pinning. The TLS handshake is awaited off the main thread, so the
    // setup window never freezes during "Save & Launch".
    let existing_pin = state
        .cfg
        .lock()
        .map(|c| c.pinned_cert_sha256.clone())
        .unwrap_or(None);
    let new_pin = if pin_cert {
        // Ticked = trust (or deliberately re-trust) whatever the host presents
        // now. This is the escape hatch after a legitimate certificate
        // rotation, which is exactly what the setup copy instructs.
        Some(fingerprint(server_url.clone()).await.map_err(|e| {
            format!(
                "Could not read the server certificate: {e}\n\nCheck the address, \
                 or untick \"Trust this server's certificate\"."
            )
        })?)
    } else {
        // Unticked: keep any pin already established — never silently drop one.
        existing_pin
    };

    {
        let mut cfg = state.cfg.lock().unwrap();
        cfg.server_url = Some(server_url.clone());
        cfg.auto_start = auto_start;
        cfg.minimize_to_tray = minimize_to_tray;
        if new_pin.is_some() {
            cfg.pinned_cert_sha256 = new_pin;
        }
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

    // TOFU re-check, deliberately awaited here. This command already runs on
    // Tauri's async runtime, so routing through the sync `open_main` reached
    // `fingerprint_blocking` → `async_runtime::block_on` from inside that very
    // runtime, which panics ("cannot start a runtime from within a runtime").
    // With `panic = "abort"` in the release profile that panic aborted the
    // process, so "Save & Launch" silently closed the app — after the config
    // had been written, which is why relaunching worked.
    //
    // Skipped when the block above just (re)trusted the certificate: that probe
    // already read the live fingerprint, so comparing it to itself would only
    // cost another TLS round trip.
    if !pin_cert {
        if let Some(expected) = pinned_cert(&app) {
            check_pinned_cert(&expected, fingerprint(server_url.clone()).await)?;
        }
    }

    open_main_window(&app, &server_url)?;
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
}/// Native (OS-level) notification. The web app calls this when it's running
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
    // Desktop: enforce one app instance. It must be the FIRST plugin: plugins'
    // setup hooks run in registration order, and this one claims the OS-wide
    // lock and forwards latecomers to the already-running instance before any
    // other plugin touches the app.
    #[cfg(desktop)]
    let builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(
        |app, _args, _cwd| {
            if let Some(w) = app.get_webview_window(MAIN_LABEL) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            } else {
                // Not yet configured / window closed to tray: show setup instead.
                let url = app
                    .state::<AppState>()
                    .cfg
                    .lock()
                    .ok()
                    .and_then(|c| c.server_url.clone());
                let _ = match url {
                    Some(u) => open_main(app, &u),
                    None => open_setup(app),
                };
            }
        },
    ));

    #[cfg(not(desktop))]
    let builder = tauri::Builder::default();

    let builder = builder
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
            probe_certificate,
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
                    // First run. If the platform refuses a second window, show
                    // the setup page in the main window instead — the address
                    // can still be entered, and `save_config` navigates that
                    // same window to the server afterwards.
                    if let Err(e) = open_setup(&handle) {
                        eprintln!("open_setup failed ({e}); showing setup in the main window");
                        if let Err(e) = open_main_at_setup(&handle) {
                            eprintln!("setup fallback window failed: {e}");
                        }
                    }
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
