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
// Desktop toast with an OS-enforced expiration (F3): the notification plugin
// has no close on desktop, so `box:notify` bypasses it on Windows.
#[cfg(desktop)]
mod toast;

use std::sync::Mutex;

use tauri::ipc::CapabilityBuilder;
use tauri::{Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder};

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

/// Event the page raises to ask for a **desktop** toast (audit fix F3,
/// `FEATURE_PLAN.md`). An event rather than an app command for the same reason
/// as [`CHANGE_SERVER_EVENT`]: Tauri refuses app commands to remote origins,
/// while `core:event:default` is granted. The Rust side shows the toast via
/// `toast.rs`, which gives it a fixed tag (replace, don't queue) and an
/// expiration so Windows removes it from the Action Center database instead of
/// accumulating OS-held copies of notification text.
#[cfg(desktop)]
const NOTIFY_EVENT: &str = "box:notify";

/// Event the page raises when its call/unread state changes, so the desktop
/// tray can reflect it (feature 4.6, `FEATURE_PLAN.md`). An event for the same
/// reason as [`CHANGE_SERVER_EVENT`]. The payload is deliberately tiny —
/// booleans and one count — because the tray is an OS surface: it may carry
/// metadata the server already holds (counts, "muted") and never a channel
/// name, a partner name or a nickname (rule R1).
#[cfg(desktop)]
const TRAY_STATE_EVENT: &str = "box:tray-state";

/// Id of the tray icon, so the state listener can find it again from an event
/// handler (`tray_by_id`).
#[cfg(desktop)]
const TRAY_ID: &str = "e2e-tray";

/// Event the shell raises when the push-to-talk hotkey is pressed or released:
/// `{down: bool}` (feature 4.1, `FEATURE_PLAN.md`). Key STATE only — the page
/// turns it into the same gate the in-app hold button uses.
#[cfg(desktop)]
const PTT_EVENT: &str = "box:ptt";

/// Event the page raises to say which accelerator (if any) push-to-talk uses:
/// `{enabled, accelerator}`. The page owns the setting; the shell just obeys it,
/// and `enabled: false` removes the registration so a global key is never held
/// while push-to-talk is off.
#[cfg(desktop)]
const PTT_SHORTCUT_EVENT: &str = "box:ptt-shortcut";

/// Fallback accelerator when the user enables push-to-talk and leaves the field
/// blank. A chord rather than a bare key on purpose: a global shortcut swallows
/// the key system-wide, so it must not collide with ordinary typing.
#[cfg(desktop)]
const DEFAULT_PTT_SHORTCUT: &str = "Ctrl+Shift+Space";

/// Payload of [`PTT_EVENT`].
#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
struct PttPayload {
    down: bool,
}

/// The pieces of the tray that change at runtime. Tauri hands out neither the
/// tooltip nor a menu item by id after construction, so the status line is kept
/// here for [`TRAY_STATE_EVENT`] to update (4.6).
#[cfg(desktop)]
#[derive(Default)]
pub struct TrayUi {
    status: std::sync::Mutex<Option<MenuItem<tauri::Wry>>>,
}

/// Tooltip and status line for the tray: `(tooltip, status_line)`.
///
/// Pure, so the wording is unit-tested. Everything here is server-known
/// metadata — a call flag, the local mute flags, and an unread count. Nothing
/// is ever interpolated from a name (rule R1).
#[cfg(desktop)]
fn tray_status(in_call: bool, muted: bool, deafened: bool, unread: u32) -> (String, String) {
    let mut parts: Vec<String> = Vec::new();
    if in_call {
        parts.push(
            if deafened {
                "In call · deafened".to_string()
            } else if muted {
                "In call · muted".to_string()
            } else {
                "In call".to_string()
            },
        );
    }
    if unread > 0 {
        parts.push(format!("{unread} unread"));
    }
    if parts.is_empty() {
        ("E2E Chat".to_string(), "Not in a call".to_string())
    } else {
        let summary = parts.join(" · ");
        (format!("E2E Chat — {summary}"), summary)
    }
}

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

/// What a cold start concluded about the saved address.
#[cfg(not(desktop))]
#[derive(Debug, PartialEq, Eq)]
enum Launch {
    /// The host answered — open the app window.
    App,
    /// The host answered *and refused*: nothing is listening there, so the only
    /// screen that can fix it is the address screen.
    Setup,
    /// No answer at all. Open the app window anyway (see [`launch_for_probe`])
    /// and watch from behind it in case the host never turns up.
    AppUnconfirmed,
}

/// Which screen a saved address should open, given one probe result.
///
/// This is the whole of the box's relaunch rule, and it exists because the rule
/// used to be "the probe did not succeed → show the address screen". On a phone
/// that is the wrong answer most of the time: Tailscale needs a moment to come
/// up after a cold boot, and the box then demanded the address be typed again
/// even though the saved one was perfectly correct — with the user's session
/// gone, because the app window never opened. Only a **refusal** is evidence
/// that there is genuinely nothing at that IP/port; anything else (a timeout, a
/// DNS answer that never comes, a TLS failure) is "could not tell yet".
///
/// Pure, so the rule is unit-tested rather than argued about — see
/// `saved_address_routing_never_strands_the_user`.
#[cfg(not(desktop))]
fn launch_for_probe(probe: Result<String, cert_probe::ProbeFailure>) -> Launch {
    match probe {
        Ok(_) => Launch::App,
        Err(cert_probe::ProbeFailure::Refused) => Launch::Setup,
        Err(cert_probe::ProbeFailure::Unknown(_)) => Launch::AppUnconfirmed,
    }
}

/// Probe the saved address for the launch decision. Bounded by the connect/read
/// timeouts in `cert_probe`.
#[cfg(not(desktop))]
fn launch_for(url: &str) -> Launch {
    launch_for_probe(cert_probe::fingerprint_of_classified(url))
}

/// Watch an *unconfirmed* host from behind the app window that was just opened.
///
/// The launch is deliberately not delayed by this: the window opens immediately,
/// which is what was asked for. The problem it solves is the one the old
/// behaviour was avoiding — a phone has no tray and no address bar, so an app
/// window sitting on the WebView's own error page used to have no way out at all.
///
/// So, off the main thread and with no effect on startup time:
///
/// * if the host answers within ~30 s (Tailscale finishing its own start-up is
///   the usual reason it did not answer yet), the window is pointed at it again
///   and the app simply loads — the user never sees the address screen;
/// * if it never answers, the address screen is shown *with the reason*, which
///   is the only place an address can be corrected on a phone.
///
/// It gives up as soon as the user has taken over: the saved address changed, or
/// the window is showing one of the app's own bundled pages (the setup screen —
/// they asked for it deliberately through *Settings → Change server address*,
/// and nothing should yank it away mid-typing).
#[cfg(not(desktop))]
fn watch_unconfirmed_host(app: tauri::AppHandle, url: String) {
    std::thread::spawn(move || {
        // 12 × 2.5 s ≈ 30 s. Long enough for a phone's Tailscale to come up,
        // short enough that the address screen still appears in the same launch.
        for _ in 0..12 {
            std::thread::sleep(std::time::Duration::from_millis(2500));

            let Some(window) = app.get_webview_window(MAIN_LABEL) else {
                return; // closed, or the app is shutting down
            };
            // The user has moved on: another address was saved, or they opened
            // the address screen themselves.
            let saved = app
                .state::<AppState>()
                .cfg
                .lock()
                .ok()
                .and_then(|c| c.server_url.clone());
            if saved.as_deref() != Some(url.as_str()) {
                return;
            }
            if window.url().map(|u| is_app_page(&u)).unwrap_or(false) {
                return;
            }

            if cert_probe::fingerprint_of_classified(&url).is_ok() {
                // Somewhere behind that error page the host has appeared; load
                // the app for real, still without asking for anything.
                eprintln!("saved host {url} answered again; loading the app");
                match url.parse::<tauri::Url>() {
                    Ok(parsed) => {
                        let _ = window.navigate(parsed);
                    }
                    Err(e) => eprintln!("could not re-open {url}: {e}"),
                }
                return;
            }
        }

        // Never answered. Say why on the address screen, which is the only
        // screen on a phone that can do anything about it.
        eprintln!("saved host {url} never answered; showing setup");
        if let Ok(mut slot) = app.state::<AppState>().startup_error.lock() {
            *slot = Some(format!(
                "Nothing answered at {url}. Check that the host is running and that \
                 Tailscale is connected on this device, then save this address again."
            ));
        }
        let _ = open_setup_in_main(&app);
    });
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

    /// 4.6: the tray's wording. The tray is an OS surface shown to whoever is
    /// standing at the machine, so it may only ever carry server-known
    /// metadata: a call flag, local mute flags and a count. This pins the
    /// wording AND the rule (nothing name-shaped gets interpolated).
    #[cfg(desktop)]
    #[test]
    fn tray_shows_state_and_counts_but_never_a_name() {
        let (tip, line) = tray_status(false, false, false, 0);
        assert_eq!(tip, "E2E Chat");
        assert_eq!(line, "Not in a call");

        let (tip, line) = tray_status(true, false, false, 0);
        assert_eq!(line, "In call");
        assert_eq!(tip, "E2E Chat — In call");

        // Mute wins the wording when deafen is off, deafen wins otherwise.
        assert_eq!(tray_status(true, true, false, 0).1, "In call · muted");
        assert_eq!(tray_status(true, true, true, 0).1, "In call · deafened");

        // Unread is a count, call or no call.
        assert_eq!(tray_status(false, false, false, 3).1, "3 unread");
        assert_eq!(tray_status(true, false, false, 3).1, "In call · 3 unread");

        // The rule itself: no `@`, no name-ish punctuation, ever.
        for st in [tray_status(true, true, false, 0).1, tray_status(false, false, false, 12).1] {
            assert!(!st.contains('@'), "{st}");
            assert!(!st.contains('"'), "{st}");
        }
    }

    /// 4.1: the shortcut the Settings field advertises as the default has to be
    /// one the shell can actually register, and a typo has to be rejected
    /// rather than silently registering nothing.
    #[cfg(desktop)]
    #[test]
    fn the_default_ptt_shortcut_parses_and_nonsense_does_not() {
        assert!(
            DEFAULT_PTT_SHORTCUT
                .parse::<tauri_plugin_global_shortcut::Shortcut>()
                .is_ok(),
            "the documented default must be registerable"
        );
        assert!(
            "not a key".parse::<tauri_plugin_global_shortcut::Shortcut>().is_err(),
            "a typo must be refused, not silently ignored"
        );
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

    /// The relaunch rule, on every kind of probe answer.
    ///
    /// The regression it guards is the box's oldest mobile complaint: a cold
    /// start showed the address screen ("enter the IP again") whenever the probe
    /// did not come back instantly, even though the saved address was fine — most
    /// often because Tailscale needs a moment after a phone boots. Only a
    /// *refusal* may route to setup; a timeout must open the app window.
    #[cfg(not(desktop))]
    #[test]
    fn saved_address_routing_never_strands_the_user() {
        use cert_probe::ProbeFailure;
        assert_eq!(launch_for_probe(Ok("aa11".into())), Launch::App);
        assert_eq!(launch_for_probe(Err(ProbeFailure::Refused)), Launch::Setup);
        assert_eq!(
            launch_for_probe(Err(ProbeFailure::Unknown("timed out".into()))),
            Launch::AppUnconfirmed
        );
        assert_eq!(
            launch_for_probe(Err(ProbeFailure::Unknown("Cannot resolve x: dns".into()))),
            Launch::AppUnconfirmed
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

    // Android-only shell behaviour (immersive bars, Back button), same reasoning
    // as above: its own capability, so a failure to resolve it is contained.
    let box_shell = CapabilityBuilder::new("remote-box-shell")
        .remote(origin.clone())
        .window(MAIN_LABEL)
        .permission("box-shell:default");
    if let Err(e) = app.add_capability(box_shell) {
        eprintln!("grant_remote_ipc: box-shell for {origin} failed: {e}");
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
    // 4.6: a disabled line that tracks call state and unread count. The tooltip
    // says the same thing, but a tooltip is easy to miss (and some shells do
    // not draw it at all), so the menu carries it too.
    let status = MenuItem::with_id(app, "status", "Not in a call", false, None::<&str>)?;
    let change = MenuItem::with_id(app, "change", "Change Server Address…", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&status, &separator, &show, &change, &separator2, &quit],
    )?;

    // Hand the status line to the state listener (see TRAY_STATE_EVENT).
    if let Ok(mut slot) = app.state::<TrayUi>().status.lock() {
        *slot = Some(status.clone());
    }

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
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
            // 4.4 (FEATURE_PLAN.md): a cold-start deep link arrives on THIS
            // (second) launch's argv. Hand the raw argv to the deep-link
            // plugin — it validates the shape itself (bin + exactly one
            // configured-scheme URL) and raises `deep-link://new-url` for the
            // page. This is the pairing the plugin documents: without it,
            // `e2e-chat://…` while the app is closed opens a plain window.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link()
                    .handle_cli_arguments(_args.iter().map(|s| s.as_str()));
            }
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
        .plugin(tauri_plugin_call_service::init())
        // Android shell behaviour: immersive system bars, and Back closing the
        // current layer instead of the app. Also registered everywhere so the
        // ACL is identical; inert on desktop.
        .plugin(tauri_plugin_box_shell::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        None,
    ));

    // 4.1 (FEATURE_PLAN.md): the global push-to-talk hotkey. Registered from
    // Rust only, so no capability/ACL entry is involved (the ACL gates IPC from
    // the webview, and nothing here is callable from it). The handler carries
    // key state and nothing else — no channel, no partner, no content.
    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                use tauri_plugin_global_shortcut::ShortcutState;
                let down = event.state == ShortcutState::Pressed;
                if let Err(e) = app.emit(PTT_EVENT, PttPayload { down }) {
                    eprintln!("{PTT_EVENT}: could not reach the page: {e}");
                }
            })                .build(),
    );

    // 4.4 (FEATURE_PLAN.md): e2e-chat:// scheme registration comes from
    // tauri.conf.json (plugins.deep-link.desktop.schemes). The page only ever
    // receives the raw URL — accepting it (id-route validation) is the page's
    // job, see `window.__handleDeepLink` in chat.js.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

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
            // Mobile routing rule (see `launch_for_probe`): a refused address —
            // and only a refused address — goes to the setup screen. A host that
            // could not be reached yet opens the app window anyway and is watched
            // from behind, because re-typing a correct address is not a fix for
            // "Tailscale has not finished starting".
            #[cfg(not(desktop))]
            let saved_url = saved_url.and_then(|url| match launch_for(&url) {
                Launch::App => Some(url),
                Launch::Setup => {
                    eprintln!("nothing is listening at {url}; showing setup");
                    None
                }
                Launch::AppUnconfirmed => {
                    eprintln!("saved host {url} did not answer yet; opening the app and watching");
                    watch_unconfirmed_host(handle.clone(), url.clone());
                    Some(url)
                }
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

            // F3: the page's desktop-toast requests. Payload is the same shape
            // `showBrowserNotification` emits: {title, body, ttl}.
            #[cfg(desktop)]
            {
                #[derive(serde::Deserialize)]
                struct ToastPayload {
                    title: String,
                    #[serde(default)]
                    body: String,
                    #[serde(default = "default_toast_ttl")]
                    ttl: u64,
                }

                fn default_toast_ttl() -> u64 {
                    10
                }

                let for_toast = handle.clone();
                handle.listen(NOTIFY_EVENT, move |event| {
                    match serde_json::from_str::<ToastPayload>(event.payload()) {
                        Ok(p) => {
                            if let Err(e) = toast::show(&for_toast, &p.title, &p.body, p.ttl) {
                                eprintln!("{NOTIFY_EVENT}: desktop toast failed: {e}");
                            }
                        }
                        Err(e) => eprintln!("{NOTIFY_EVENT}: bad payload: {e}"),
                    }
                });
            }

            // 4.6: the tray's call/unread state. Same event-channel reason as
            // the toast above; an unknown payload is ignored (the tray simply
            // keeps its last text rather than showing something invented).
            #[cfg(desktop)]
            {
                #[derive(serde::Deserialize, Default)]
                #[serde(default)]
                struct TrayState {
                    in_call: bool,
                    muted: bool,
                    deafened: bool,
                    unread: u32,
                }

                let for_tray = handle.clone();
                handle.listen(TRAY_STATE_EVENT, move |event| {
                    let st = serde_json::from_str::<TrayState>(event.payload()).unwrap_or_default();
                    let (tooltip, status) = tray_status(st.in_call, st.muted, st.deafened, st.unread);
                    if let Some(tray) = for_tray.tray_by_id(TRAY_ID) {
                        let _ = tray.set_tooltip(Some(&tooltip));
                    }
                    if let Ok(slot) = for_tray.state::<TrayUi>().status.lock() {
                        if let Some(item) = slot.as_ref() {
                            let _ = item.set_text(status);
                        }
                    }
                });
            }

            // 4.1: which key is push-to-talk, as decided by the page's
            // settings. Re-registering always unregisters first, so a changed
            // accelerator can never leave the old key held.
    // 4.2 (FEATURE_PLAN.md): the always-on-top mini call window. The page asks
    // for it over an event (app commands are refused to the remote origin —
    // same reason as box:notify). It loads the same index.html with ?mini=1,
    // which boots a CONTROLS-ONLY view: no chat boot, no socket, no decryption
    // of its own — buttons emit `box:mini-control` for the main window (which
    // owns the call) to act on, and the main window pushes `box:call-state`
    // back. Local pixels on the user's own screen: same exposure as the main
    // window being visible (plan verdict for 4.2).
    #[cfg(desktop)]
    {
        const MINI_WINDOW_EVENT: &str = "box:mini-window";
        let for_mini = handle.clone();
        handle.listen(MINI_WINDOW_EVENT, move |event| {
            #[derive(serde::Deserialize, Default)]
            #[serde(default)]
            struct MiniReq {
                open: bool,
            }
            let req: MiniReq = serde_json::from_str(event.payload()).unwrap_or_default();
            if req.open {
                if let Some(w) = for_mini.get_webview_window("mini") {
                    let _ = w.set_focus();
                    return;
                }
                let win = tauri::WebviewWindowBuilder::new(
                    &for_mini,
                    "mini",
                    tauri::WebviewUrl::App("index.html?mini=1".into()),
                )
                .title("E2E Chat — call controls")
                .inner_size(320.0, 170.0)
                .min_inner_size(240.0, 120.0)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .build();
                if let Err(e) = win {
                    eprintln!("{MINI_WINDOW_EVENT}: could not open: {e}");
                }
            } else if let Some(w) = for_mini.get_webview_window("mini") {
                let _ = w.close();
            }
        });
    }

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;

                #[derive(serde::Deserialize, Default)]
                #[serde(default)]
                struct PttShortcut {
                    enabled: bool,
                    accelerator: String,
                }

                let for_ptt = handle.clone();
                handle.listen(PTT_SHORTCUT_EVENT, move |event| {
                    let cfg =
                        serde_json::from_str::<PttShortcut>(event.payload()).unwrap_or_default();
                    let shortcuts = for_ptt.global_shortcut();
                    let _ = shortcuts.unregister_all();
                    if !cfg.enabled {
                        return;
                    }
                    let accelerator = if cfg.accelerator.trim().is_empty() {
                        DEFAULT_PTT_SHORTCUT.to_string()
                    } else {
                        cfg.accelerator.trim().to_string()
                    };
                    match accelerator.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                        Ok(sc) => {
                            if let Err(e) = shortcuts.register(sc) {
                                eprintln!(
                                    "{PTT_SHORTCUT_EVENT}: could not register {accelerator}: {e}"
                                );
                            }
                        }
                        Err(e) => eprintln!(
                            "{PTT_SHORTCUT_EVENT}: '{accelerator}' is not a usable key: {e}"
                        ),
                    }
                });
            }

            #[cfg(desktop)]
            handle.manage(TrayUi::default());
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
