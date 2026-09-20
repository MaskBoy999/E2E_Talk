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
#[cfg(windows)]
mod win_webview;

use std::sync::Mutex;

use tauri::ipc::CapabilityBuilder;
use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;
#[cfg(desktop)]
use tauri::WindowEvent;
#[cfg(desktop)]
use tauri_plugin_autostart::MacosLauncher;

use tauri_plugin_opener::OpenerExt;

use config::Config;

const MAIN_LABEL: &str = "main";
const SETUP_LABEL: &str = "setup";
const SETUP_PAGE: &str = "box-setup.html";

/// Event the web app's *Settings → Connection* tab emits to ask for the setup
/// screen. It has to be an event and not a command: the main window renders the
/// host's page, and Tauri refuses a remote origin every app command unless a
/// capability grants it (see `run()`, and `grant_remote_ipc` for what that
/// origin does get).
const CHANGE_SERVER_EVENT: &str = "box:change-server";

/// Shared state so window events and commands can read the live config.
#[derive(Default)]
pub struct AppState {
    pub cfg: Mutex<Config>,
    /// Why the last launch could not open the app window, if it could not.
    ///
    /// Startup falls back to the setup screen when the saved host is broken
    /// (certificate changed, address dead), and until this existed that fallback
    /// was silent: the user just saw the address screen again. On a phone there
    /// is no console to read, so the reason has to reach the page.
    pub startup_error: Mutex<Option<String>>,
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

/// Whether a successfully probed fingerprint differs from the pinned one.
///
/// Split out of `test_connection` so it can be unit-tested without an
/// `AppHandle`. It exists because a pinned client refuses a changed certificate,
/// and `reqwest` reports that refusal as a *connection* error — which the setup
/// screen then rendered as "Connection refused — is the server running on this
/// port?", sending the user after the wrong problem entirely. Checking the
/// fingerprint first means the one message that matters (re-trust, or do not
/// connect) is the one shown.
///
/// `None` when the host could not be probed at all: then there is no evidence of
/// a certificate change, and the caller's own request error is the better
/// message.
fn pin_mismatch(pinned: Option<&str>, probed: Result<String, String>) -> Option<String> {
    match (pinned, probed) {
        (Some(expected), Ok(actual)) if actual != expected => Some(cert_probe::mismatch_message()),
        _ => None,
    }
}

/// Whether the configured host answers at all (TCP connect + TLS handshake),
/// i.e. whether the main window could load anything from it.
///
/// `fingerprint_blocking` errors exactly when nothing could be reached — DNS
/// failure, connection refused, timeout — while a *changed certificate* still
/// probes successfully. So this is **not** a pin check (that is
/// `check_pinned_cert`, which deliberately treats an unreachable host as
/// acceptable so an offline launch still opens the app window); it answers the
/// blunter question "is this address alive?". Bounded by the connect/read
/// timeouts in `cert_probe`.
#[cfg(not(desktop))]
fn host_reachable(url: &str) -> bool {
    fingerprint_blocking(url).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A launch that cannot establish a pin must be refused rather than opened:
    /// the window would be handed the host's self-signed certificate with nothing
    /// to accept it, which is Chromium's "Your connection isn't private" page
    /// instead of the app.
    #[test]
    fn an_unpinnable_host_must_not_open_the_app_window() {
        let err = require_pin(false, false, "https://100.1.2.3:3443")
            .expect_err("an unpinned, unreadable host must not open the app window");
        // The message has to name the address and the fix: the setup screen shows
        // it verbatim, and it is the only explanation a phone gets.
        assert!(err.contains("100.1.2.3:3443"), "{err}");
        assert!(err.contains("reachable"), "{err}");

        // Anything already trusted opens normally — including the ordinary case
        // where the pin was established earlier in this same launch.
        assert!(require_pin(true, false, "https://100.1.2.3:3443").is_ok());
        assert!(require_pin(false, true, "https://100.1.2.3:3443").is_ok());
        assert!(require_pin(true, true, "https://100.1.2.3:3443").is_ok());
    }

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

    /// A changed certificate must be reported as a changed certificate, not as
    /// an unreachable host: the message is the only diagnosis the setup screen can
    /// give, and the two need completely different responses from the user.
    #[test]
    fn a_changed_certificate_is_never_reported_as_a_connection_problem() {
        let pin = "aa11";
        assert!(pin_mismatch(Some(pin), Ok("bb22".into())).is_some());
        // Same certificate, or nothing trusted yet: not a mismatch.
        assert!(pin_mismatch(Some(pin), Ok(pin.into())).is_none());
        assert!(pin_mismatch(None, Ok("bb22".into())).is_none());
        // Unreachable host: the caller's own request error says more.
        assert!(pin_mismatch(Some(pin), Err("refused".into())).is_none());
    }

    /// The navigation allowlist must compare whole origins: the same host on a
    /// different port (or on `http` rather than `https`) is a different server,
    /// and nothing remote may load before setup has been completed.
    #[test]
    fn only_the_configured_origin_may_load_in_the_app_window() {
        let host = "https://100.1.2.3:3443";
        let allowed: tauri::Url = "https://100.1.2.3:3443/chat".parse().unwrap();
        assert!(nav_allowed(&allowed, Some(host)));

        for bad in [
            "https://100.1.2.3:3444/",       // same host, another port
            "http://100.1.2.3:3443/",        // same host and port, other scheme
            "https://100.1.2.4:3443/",       // another host
            "https://100.1.2.3.evil.com:3443/", // lookalike hostname
        ] {
            let url: tauri::Url = bad.parse().unwrap();
            assert!(
                !nav_allowed(&url, Some(host)),
                "{bad} must be handed to the system browser"
            );
        }

        // No host configured yet (first run) — nothing remote is allowed.
        assert!(!nav_allowed(&allowed, None));
        // A malformed saved host must not open the whole web up, either.
        assert!(!nav_allowed(&allowed, Some("not a url")));

        // The app's own bundled pages always are: on mobile the setup page
        // replaces the main window's content and is not on the host's origin.
        assert!(nav_allowed(&app_page_url(SETUP_PAGE).unwrap(), Some(host)));
        // As are local, non-network schemes (blob: for media/attachments).
        let blob: tauri::Url = "blob:https://100.1.2.3:3443/abc".parse().unwrap();
        assert!(nav_allowed(&blob, Some(host)));
    }

    /// The navigation allowlist has to let the app's own bundled pages through:
    /// on mobile the setup page *replaces* the main window, and its origin is not
    /// the configured server. A lookalike host or a lookalike scheme must still
    /// be refused — note `evil://localhost` in particular, which an
    /// `Url::origin()`-based check would wave straight through, because
    /// non-special schemes report an opaque `null` origin.
    #[test]
    fn bundled_pages_are_local_but_lookalikes_are_not() {
        let page = app_page_url(SETUP_PAGE).expect("the setup page URL must build");
        assert!(is_app_page(&page), "{page} is a bundled page");

        for bad in [
            "https://100.1.2.3:3443/box-setup.html",
            "http://tauri.localhost.evil.com/box-setup.html",
            "evil://localhost/box-setup.html",
        ] {
            let url: tauri::Url = bad.parse().unwrap();
            assert!(!is_app_page(&url), "{bad} must not count as a bundled page");
        }
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

    // Core capability (events + native notifications). This one must hold: it
    // is what lets the page raise the `box:change-server` event, and what makes
    // the notification plugin's `window.Notification` shim reachable — without
    // it the page has no `window.__TAURI__` at all and notifications stop.
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
    } else {
        // Nothing trusted yet — a config from an older build, or one edited by
        // hand. Record what the host presents now, or refuse to open the window
        // at all (see `require_pin`).
        let established = ensure_pin_blocking(app, server_url);
        require_pin(false, established, server_url)?;
    }
    open_main_window(app, server_url)
}

/// Refuse to open the app window when nothing is pinned **and** the host's
/// certificate could not be read to pin it now.
///
/// This is the guard for the box's most persistent symptom. The configured host
/// is self-signed, so the pinned fingerprint is the app's only trust anchor —
/// and the sandboxed WebView (WebView2, and the Android WebView) has to be *told*
/// to accept the certificate that was verified, or it shows Chromium's
/// *"Your connection isn't private"* page instead of the app. With no pin there
/// is nothing to tell it.
///
/// The hole this closes is a launch race, not a hypothetical: start the app
/// before the server is listening and `fingerprint_blocking` fails, so an older
/// build opened the window unpinned (the certificate hook is installed once, at
/// window creation). The first load that *did* succeed then hit the certificate
/// warning — every time, until the pin happened to get written.
///
/// Split out from `open_main` so the decision is testable without an `AppHandle`.
/// `has_pin` is whether a pin already exists; `established` whether one was just
/// recorded. Both false is the only refusal.
fn require_pin(has_pin: bool, established: bool, server_url: &str) -> Result<(), String> {
    if has_pin || established {
        return Ok(());
    }
    Err(format!(
        "no certificate is trusted for {server_url} yet, and its certificate could \
         not be read to trust it now. Check that the host is running and reachable, \
         then press Save & Launch again."
    ))
}

/// Record the host's certificate fingerprint when none is pinned yet.
///
/// Returns whether a pin now exists. Used on the sync launch paths; the async
/// `save_config` does the same thing with an awaited probe (calling the blocking
/// variant from there would panic on Tauri's own runtime).
fn ensure_pin_blocking(app: &tauri::AppHandle, server_url: &str) -> bool {
    match fingerprint_blocking(server_url) {
        Ok(actual) => {
            if let Ok(mut cfg) = app.state::<AppState>().cfg.lock() {
                cfg.pinned_cert_sha256 = Some(actual.clone());
                if let Err(e) = config::save(app, &cfg) {
                    eprintln!("could not persist the certificate pin: {e}");
                }
            }
            eprintln!(
                "no certificate was pinned yet; trusting {} for {server_url} from now on",
                cert_probe::short_fingerprint(&actual)
            );
            true
        }
        Err(e) => {
            eprintln!("could not read the host certificate to pin it ({e})");
            false
        }
    }
}

/// Extra browser arguments for the app window, or `None` to keep wry's defaults.
///
/// Exactly one thing lives here, and it is opt-in: a **remote debugging port**,
/// so the box's WebView can be driven and read by the same tooling as the rest of
/// the app (`chrome://inspect`, or Playwright's `connectOverCDP` for the box
/// tests). Set `E2E_BOX_DEBUG_PORT=9333` in the environment before launching:
///
/// ```text
/// E2E_BOX_DEBUG_PORT=9333 ./e2e-chat-app.exe
/// curl -s http://127.0.0.1:9333/json/list
/// ```
///
/// It is deliberately not a build-time switch. An open debugging port lets
/// anything that can reach the loopback interface drive the app's WebView, so a
/// shipped build must never have one — and nothing sets this variable unless the
/// person launching the app does.
///
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` cannot be used for this instead: wry
/// always calls `set_additional_browser_arguments` (with its own defaults when
/// the app passes none), which overrides that environment variable. Overriding
/// it here also means repeating wry's defaults, since setting the argument
/// *replaces* them rather than appending — without them the Office/PDF overlay
/// UI and SmartScreen would quietly come back and make a debug run behave
/// differently from a normal one.
fn webview_browser_args() -> Option<String> {
    let port = std::env::var("E2E_BOX_DEBUG_PORT").ok()?;
    let port = port.trim().to_string();
    if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
        eprintln!("E2E_BOX_DEBUG_PORT={port:?} is not a port number; ignoring it");
        return None;
    }
    // `--remote-allow-origins=*`: recent Chromium refuses a DevTools client whose
    // Origin is not allowlisted, which is how a CDP attach presents itself.
    Some(format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
         --remote-debugging-port={port} --remote-allow-origins=*"
    ))
}

/// The main window's navigation allowlist: the window may only ever show the
/// configured host, the app's own bundled pages, or local `blob:`/`data:`
/// URLs. Anything else — a link in a message, a redirect to another site — is
/// handed to the system browser instead of being loaded inside the app.
///
/// Shared by *both* places that can create the main window, which matters on
/// mobile: there the setup page is the first thing the main window ever shows
/// (first run, or an unreachable saved host), so `open_setup_in_main` builds it
/// too. A main window built without this would follow whatever a message links
/// to, and a phone has no tray, no address bar and no back button to recover
/// with.
fn nav_allowlist(app: &tauri::AppHandle) -> impl Fn(&tauri::Url) -> bool + Send + 'static {
    let nav_app = app.clone();
    move |url: &tauri::Url| {
        // Read the live config so changing the server from the tray takes
        // effect immediately, without rebuilding the window.
        let configured = nav_app
            .state::<AppState>()
            .cfg
            .lock()
            .ok()
            .and_then(|c| c.server_url.clone());
        if nav_allowed(url, configured.as_deref()) {
            return true;
        }
        let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
        false
    }
}

/// The decision half of [`nav_allowlist`], split out so it can be unit-tested
/// without an `AppHandle`.
///
/// Comparison is on `Url::origin()` — scheme + host + **port** — so the same
/// host on another port, or the same host on `http` instead of `https`, is a
/// different server and is *not* allowed.
fn nav_allowed(url: &tauri::Url, configured: Option<&str>) -> bool {
    // The app's own bundled pages: on mobile the setup page replaces the main
    // window's content, and its origin is *not* the configured server, so
    // without this the address screen would be punted to the system browser and
    // the change-server flow could never come back.
    if is_app_page(url) {
        return true;
    }
    // Local (blob:, data:, about:) — no network risk.
    if !matches!(url.scheme(), "http" | "https") {
        return true;
    }
    let allowed = configured
        .and_then(|s| s.parse::<tauri::Url>().ok())
        .map(|u| u.origin());
    allowed.as_ref() == Some(&url.origin())
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

    // The window starts on a blank page and is pointed at the server afterwards.
    // On Windows the WebView2 hooks below (the pinned certificate, auto-granted
    // permissions) are raised *per navigation*, so they have to be installed
    // before the first request to a remote URL — creating the window straight on
    // that URL would let the first load race them, which is exactly how the
    // "Your connection isn't private" page kept appearing. The window is hidden
    // until the navigation has been requested, so the blank page is never seen.
    let blank: tauri::Url = "about:blank"
        .parse()
        .map_err(|e| format!("could not build the initial page: {e}"))?;
    let mut builder = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::External(blank))
        .title("E2E Chat")
        .inner_size(1200.0, 780.0)
        .min_inner_size(720.0, 480.0)
        .visible(false)
        // Tauri installs a *native* drop handler on the webview by default
        // (`dragDropEnabled`, default true). On Windows that handler swallows
        // HTML5 drag-and-drop inside the page, so every drag target in the app
        // silently stops firing — while the same page works in a browser,
        // which has no such handler. The UI uses HTML5 DnD exclusively and
        // never Tauri's `tauri://drag-*` events, so turn the native one off.
        .disable_drag_drop_handler()
        // Navigation allowlist — see `nav_allowlist`.
        .on_navigation(nav_allowlist(app));
    if let Some(args) = webview_browser_args() {
        builder = builder.additional_browser_args(&args);
    }
    let window = builder.build().map_err(|e| e.to_string())?;

    #[cfg(windows)]
    win_webview::install(&window);

    // Never leave an invisible window behind: whatever happens, the user sees a
    // window (the error path shows the blank one rather than nothing at all).
    if let Err(e) = window.navigate(parsed) {
        let _ = window.show();
        return Err(e.to_string());
    }
    #[cfg(desktop)]
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// The URL a page bundled with the app is served from — i.e. what
/// `WebviewUrl::App(page)` resolves to once Tauri has picked the
/// custom-protocol base.
///
/// Tauri derives that base in `RuntimeManager::get_app_url` (private):
/// `http://tauri.localhost` on Windows and Android, `tauri://localhost`
/// elsewhere (or `devUrl` in a dev build that sets one — this app does not).
/// `navigate()` needs a real `Url`, so the base is reproduced here to put an
/// existing window back on a bundled page.
fn app_page_url(page: &str) -> Result<tauri::Url, String> {
    let base = if cfg!(windows) || cfg!(target_os = "android") {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    format!("{base}/{page}").parse().map_err(|e| format!("{e}"))
}

/// Whether a URL points at one of the app's own bundled pages rather than at the
/// remote server.
///
/// Scheme + host deliberately, not `Url::origin()`: `tauri://localhost` uses a
/// non-special scheme, so the `url` crate reports an **opaque** origin (`null`)
/// for it — and `null == null` would then accept any non-special scheme at all.
fn is_app_page(url: &tauri::Url) -> bool {
    if cfg!(windows) || cfg!(target_os = "android") {
        matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")
    } else {
        url.scheme() == "tauri" && url.host_str() == Some("localhost")
    }
}

/// Show the setup page **in the main window** — the single-window fallback.
///
/// `save_config` navigates this same window to the address it saved, so the
/// change-server flow completes without ever needing a second window.
fn open_setup_in_main(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        w.navigate(app_page_url(SETUP_PAGE)?)
            .map_err(|e| e.to_string())?;
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    // On mobile this **is** the main window, so it needs the same navigation
    // allowlist as `open_main_window` — a window built without it would follow
    // any external link away from the host, with no tray, no address bar and no
    // back button on a phone to recover.
    let mut builder = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App(SETUP_PAGE.into()))
        .title("E2E Chat — Setup")
        .inner_size(560.0, 660.0)
        .on_navigation(nav_allowlist(app));
    if let Some(args) = webview_browser_args() {
        builder = builder.additional_browser_args(&args);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Open (or focus) the local setup screen — where the server address is entered
/// and tested. Reached from the tray, from app startup, and from the web app's
/// *Settings → Connection* tab (over [`CHANGE_SERVER_EVENT`]).
///
/// Desktop gets its own window. Mobile does not: a second Tauri window there
/// needs extra Activities declared in the generated Android project (Tauri's
/// multi-window guide) and on a phone it would only cover the app anyway — so on
/// mobile the setup page takes over the main window instead.
fn open_setup(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(SETUP_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    #[cfg(desktop)]
    {
        let mut setup_builder =
            WebviewWindowBuilder::new(app, SETUP_LABEL, WebviewUrl::App(SETUP_PAGE.into()))
                .title("E2E Chat — Setup")
                .inner_size(560.0, 660.0)
                .resizable(false);
        if let Some(args) = webview_browser_args() {
            setup_builder = setup_builder.additional_browser_args(&args);
        }
        match setup_builder.build()
        {
            Ok(_) => return Ok(()),
            // A platform that refuses a second window must not leave the setup
            // screen unreachable — fall through to the main window.
            Err(e) => eprintln!("setup window failed ({e}); showing setup in the main window"),
        }
    }

    open_setup_in_main(app)
}

// ── Commands ─────────────────────────────────────────────────────────────

#[tauri::command]
fn get_config(state: tauri::State<'_, AppState>) -> Config {
    state.cfg.lock().unwrap().clone()
}

/// The reason the last launch fell back to this setup screen, or `None`.
///
/// Only ever reachable from a local page (the setup window / `open_setup_in_main`),
/// which is exactly where it is needed — a phone has no stderr to read.
#[tauri::command]
fn get_startup_error(state: tauri::State<'_, AppState>) -> Option<String> {
    state.startup_error.lock().ok().and_then(|e| e.clone())
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
    // A changed certificate is the first thing to rule out, because it is the one
    // failure the request below cannot describe accurately: with a pin set,
    // `pinned_client` refuses any other certificate and the refusal arrives as a
    // connect error. `test_connection` is the box's only diagnostic, so it has to
    // name the real problem.
    if let Some(message) = pin_mismatch(pinned.as_deref(), fingerprint(url.clone()).await) {
        return Ok(ConnResult {
            ok: false,
            status: None,
            detail: message,
        });
    }

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
                "Could not read the server certificate: {e}\n\nCheck that the host is \
                 running and reachable at this address."
            )
        })?)
    } else {
        // Unticked (only reachable for a config written by an older build): keep
        // any pin already established — never silently drop one.
        existing_pin
    };
    // A self-signed host has no other trust anchor, so a launch with *no* pin has
    // nothing to compare against and no way to tell the WebView what to accept.
    // Record what the host presents now (the setup screen's checkbox is ticked by
    // default, so this is the path for configs that lost their pin) — and if even
    // that fails, stop here rather than opening the app window unpinned, which
    // would show the browser's certificate warning instead of the app.
    let new_pin = match new_pin {
        Some(pin) => Some(pin),
        None => match fingerprint(server_url.clone()).await {
            Ok(actual) => {
                eprintln!(
                    "no certificate was pinned yet; trusting {} for {server_url} from now on",
                    cert_probe::short_fingerprint(&actual)
                );
                Some(actual)
            }
            Err(e) => {
                eprintln!("could not read the host certificate to pin it ({e})");
                None
            }
        },
    };
    if new_pin.is_none() {
        return Err(format!(
            "Could not read the server certificate at {server_url}: nothing is trusted for \
             this address yet, so the app would have to open it with an unverified \
             certificate. Check that the host is running and reachable, then press \
             Save & Launch again."
        ));
    }

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
    // This launch works — drop any stale failure the setup screen is showing.
    if let Ok(mut slot) = app.state::<AppState>().startup_error.lock() {
        *slot = None;
    }
    if let Some(w) = app.get_webview_window(SETUP_LABEL) {
        let _ = w.close();
    }
    Ok(())
}

/// Show the setup screen again. This is the command form, so it is reachable
/// from **local** pages only (the setup page itself); the remote app page asks
/// over [`CHANGE_SERVER_EVENT`], because Tauri denies it app commands.
#[tauri::command]
fn show_setup(app: tauri::AppHandle) -> Result<(), String> {
    open_setup(&app)
}

/// Quit the app (used by the setup screen's Quit button).
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// There is deliberately **no** `notify` command any more. Notifications go
// through `tauri-plugin-notification` in every case: the plugin's init script
// replaces `window.Notification` in the WebView with a shim that posts
// `plugin:notification|notify`, which the remote origin is granted via
// `notification:default` (see `grant_remote_ipc`). The old app-level command
// looked like the box's notification path but could never be reached from the
// app's own page: Tauri rejects *app* commands from a remote origin whose
// capability does not list it, so in-box notifications silently did nothing.

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
            get_startup_error,
            test_connection,
            probe_certificate,
            save_config,
            show_setup,
            quit_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Load persisted config into shared state.
            let cfg = config::load(&handle);
            *handle.state::<AppState>().cfg.lock().unwrap() = cfg.clone();

            // Route the first window: main app when configured, setup otherwise.
            //
            // Mobile only: a saved host that cannot be reached is a dead end
            // there — no tray to reopen setup from, no address bar, so the
            // window would sit on the WebView's own error page with nothing the
            // user could do. Treat it as unconfigured and show the setup screen
            // instead; that page prefills the saved address (`get_config`), so
            // correcting a typo is one edit away.
            //
            // Desktop is deliberately left alone: it has the tray's *Change
            // Server Address…*, and probing here would delay every launch by the
            // connect timeout whenever the host is down (an error page it can
            // still escape from). Cost on the happy path is one extra TLS
            // handshake, because `open_main` probes again for the pin.
            let saved_url = cfg.server_url.clone();
            #[cfg(not(desktop))]
            let saved_url = saved_url.filter(|url| {
                let reachable = host_reachable(url);
                if !reachable {
                    eprintln!("saved host unreachable ({url}); showing setup");
                }
                reachable
            });

            match saved_url.as_deref() {
                Some(url) => {
                    if let Err(e) = open_main(&handle, url) {
                        // A broken saved address must not strand the user: fall back.
                        // Record *why* — the setup screen shows it, because on a
                        // phone this is the only channel that exists.
                        eprintln!("open_main failed ({e}); opening setup");
                        if let Ok(mut slot) = handle.state::<AppState>().startup_error.lock() {
                            *slot = Some(e);
                        }
                        let _ = open_setup(&handle);
                    }
                }
                None => {
                    // First run — or, on mobile, a host we could not reach.
                    // `open_setup` itself takes over the main window where the
                    // platform refuses a second one.
                    if let Err(e) = open_setup(&handle) {
                        eprintln!("open_setup failed: {e}");
                    }
                }
            }

            // The in-app *Settings → Connection* tab asks for the setup screen
            // over the event channel, because it cannot ask any other way: the
            // main window loads the **host's** page, and Tauri rejects every
            // *app* command from a remote origin whose capability does not list
            // it (`webview/mod.rs`: `!is_local && invoke.acl.is_none()` →
            // "Command … not allowed by ACL"). `get_config` / `show_setup` are
            // app commands, and `remote-main` grants only core/notification/
            // call-service permissions — while `core:event:default`, which
            // includes `emit`, *is* granted. A JS `emit` lands in
            // `RuntimeManager::emit`, which calls every listener registered for
            // the event name regardless of target, so this fires.
            {
                let for_events = handle.clone();
                handle.listen(CHANGE_SERVER_EVENT, move |_event| {
                    if let Err(e) = open_setup(&for_events) {
                        eprintln!("{CHANGE_SERVER_EVENT}: could not open setup: {e}");
                    }
                });
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
